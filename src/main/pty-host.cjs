// Utility processes expose the parent channel on process.parentPort. Keep the
// Electron export as a fallback for older runtimes.
const parentPort = process.parentPort || require("electron").parentPort;
const fs = require("node:fs");
const pty = require("node-pty");
const { isWindows } = require("./platform.cjs");
const { createDetector } = require("./detection-engine.cjs");
const { createOscParser } = require("./osc-parser.cjs");
const { createAgentSniffer } = require("./agent-sniff.cjs");
const { createHookServer } = require("./hook-server.cjs");
const { summarize } = require("./summary-utils.cjs");
const {
  AGENT_TYPES,
  normalizeCreateRequest,
  normalizeWriteRequest,
  normalizeResizeRequest,
  normalizeTerminalRequest,
  protocolError,
} = require("./pty-validation.cjs");

const sessions = new Map();
const sequence = new Map();
const detectors = new Map();
const oscParsers = new Map();
const agentTypes = new Map();
const creating = new Set();
const killRequests = new Set();
const buffers = new Map();
let dataPort = null;
let tickTimer = null;

// External CLI hooks/plugins post status events to this loopback server. The
// port/token are injected into each PTY environment so a hook process can find
// the bridge without any global config. See hook-server.cjs for the protocol.
const hookServer = createHookServer({
  onEvent: ({ terminalId, event, status }) => {
    const detector = detectors.get(terminalId);
    if (detector && typeof event === "string" && typeof status === "string") {
      detector.hook(event, status);
    }
  },
});
const hookReady = hookServer.start().catch((error) => {
  sendError("hook-server", error);
  return 0;
});

// Per-terminal bounded output ring buffer for replay after renderer reconnect.
const OUTPUT_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024;

// Detection is time-driven: quiet windows only advance when tick() is called.
// PTY output is bursty and can stop entirely at a prompt, so the host must
// drive every detector on a timer instead of waiting for the next output chunk.
const DETECTOR_TICK_MS = 250;

function startTickLoop() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    const now = Date.now();
    for (const detector of detectors.values()) {
      try {
        detector.tick(now);
      } catch {
        // One detector failing must not stop the others from advancing.
      }
    }
  }, DETECTOR_TICK_MS);
  if (typeof tickTimer.unref === "function") tickTimer.unref();
}

function bufferAppend(terminalId, data) {
  let entry = buffers.get(terminalId);
  if (!entry) {
    entry = { parts: [], bytes: 0 };
    buffers.set(terminalId, entry);
  }
  entry.parts.push(data);
  entry.bytes += Buffer.byteLength(data);
  while (entry.bytes > OUTPUT_BUFFER_LIMIT_BYTES && entry.parts.length > 1) {
    entry.bytes -= Buffer.byteLength(entry.parts[0]);
    entry.parts.shift();
  }
  if (entry.bytes > OUTPUT_BUFFER_LIMIT_BYTES && entry.parts.length === 1) {
    // Single oversized chunk: keep only the most recent limit bytes.
    const kept = entry.parts[0].slice(-OUTPUT_BUFFER_LIMIT_BYTES);
    entry.parts[0] = kept;
    entry.bytes = Buffer.byteLength(kept);
  }
}

function bufferRelease(terminalId) {
  buffers.delete(terminalId);
}

function replay(terminalId, fromSequence) {
  const entry = buffers.get(terminalId);
  if (!entry) return;
  const base = (sequence.get(terminalId) || 0) - entry.parts.length;
  entry.parts.forEach((data, index) => {
    const seq = base + index + 1;
    if (seq <= fromSequence) return;
    send({ type: "pty:output", terminalId, data, sequence: seq, replay: true, at: Date.now() });
  });
}

function send(message) {
  try {
    dataPort?.postMessage(message);
  } catch {
    // The renderer can reconnect after a port failure. PTY lifecycle must keep
    // running even when a transient data-port send fails.
  }
}

function sendError(operation, error, requestId, terminalId) {
  send({
    type: "pty:error",
    operation,
    requestId,
    terminalId,
    code: error?.code || "PTY_ERROR",
    message: error?.message || String(error),
    at: Date.now(),
  });
}

function makeDetector(terminalId, agentType) {
  agentTypes.set(terminalId, agentType);
  const detector = createDetector(agentType, (update) => send({
    type: "state:update",
    terminalId,
    ...update,
    // Detector summaries are raw output excerpts; sanitize them the same way.
    summary: update.summary === undefined ? undefined : summarize(update.summary),
  }));
  detectors.set(terminalId, detector);
  return detector;
}

// The renderer no longer asks the user to pick an agent type; identifying the
// CLI from its own banner keeps the dropdown (and a whole row of controls) out
// of the UI while still giving the detector the right pattern set.
function makeAgentSniffer(terminalId) {
  return createAgentSniffer((agent) => {
    if (agentTypes.get(terminalId) === agent) return;
    makeDetector(terminalId, agent);
    send({ type: "pty:agent", terminalId, agentType: agent, at: Date.now() });
  });
}

function makeOscParser(terminalId) {
  // Applications (shells, agent CLIs) report their own window title via OSC 0/2
  // and cwd via OSC 7. Emit both to the renderer so sidebar titles stay
  // meaningful without the user renaming terminals by hand.
  const parser = createOscParser(
    (title) => send({ type: "pty:title", terminalId, title, at: Date.now() }),
    (cwd) => send({ type: "pty:cwd", terminalId, cwd, at: Date.now() }),
  );
  oscParsers.set(terminalId, parser);
  return parser;
}

function assertCwd(cwd) {
  try {
    if (!fs.statSync(cwd).isDirectory()) throw protocolError("INVALID_CWD", "cwd is not a directory", { field: "cwd" });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw protocolError("INVALID_CWD", `cwd does not exist: ${cwd}`, { field: "cwd" });
    }
    throw error;
  }
}

function createSession(message, hookWaited = false) {
  // The hook port is assigned asynchronously; a create that arrives before the
  // listener is ready waits once, then proceeds with or without hook env.
  if (!hookServer.port && !hookWaited) {
    hookReady.then(() => createSession(message, true));
    return;
  }
  const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
  let request;
  try {
    request = normalizeCreateRequest(message);
    assertCwd(request.cwd);
  } catch (error) {
    sendError("pty:create", error, requestId, message?.terminalId);
    return;
  }
  if (sessions.has(request.terminalId) || creating.has(request.terminalId)) {
    sendError("pty:create", protocolError("ALREADY_EXISTS", `terminal already exists: ${request.terminalId}`), requestId, request.terminalId);
    return;
  }

  creating.add(request.terminalId);
  const hookEnv = {
    TERMBEACON_TERMINAL_ID: request.terminalId,
    ...(hookServer.port ? {
      TERMBEACON_HOOK_PORT: String(hookServer.port),
      TERMBEACON_HOOK_TOKEN: hookServer.token,
    } : {}),
  };
  let session;
  try {
    session = pty.spawn(request.shell, request.args, {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: { ...process.env, ...request.env, ...hookEnv },
      ...(isWindows ? { useConpty: true } : {}),
    });
  } catch (error) {
    creating.delete(request.terminalId);
    sendError("pty:create", error, requestId, request.terminalId);
    return;
  }

  creating.delete(request.terminalId);
  sessions.set(request.terminalId, session);
  sequence.set(request.terminalId, 0);
  bufferRelease(request.terminalId);
  // Start detection with the generic pattern set: a fresh shell is not yet an
  // agent. The sniffer upgrades the detector when a CLI banner appears.
  const detector = makeDetector(request.terminalId, "generic");
  const oscParser = makeOscParser(request.terminalId);
  const sniffer = makeAgentSniffer(request.terminalId);
  send({ type: "pty:create-result", requestId, terminalId: request.terminalId, pid: session.pid, ok: true, at: Date.now() });

  session.onData((data) => {
    const next = (sequence.get(request.terminalId) || 0) + 1;
    sequence.set(request.terminalId, next);
    bufferAppend(request.terminalId, data);
    // The sidebar renders this under the terminal title; send a sanitized
    // single line so control sequences never reach the DOM as mojibake.
    const summary = summarize(data);
    send({ type: "pty:output", terminalId: request.terminalId, data, sequence: next, replay: false, summary, at: Date.now() });
    try { oscParser.feed(data); } catch { /* title parsing must never break output delivery */ }
    try { sniffer.feed(data); } catch { /* agent sniffing must never break output delivery */ }
    detector.output(data);
    detector.tick();
  });
  session.onExit(({ exitCode }) => {
    const reason = killRequests.delete(request.terminalId) ? "user-kill" : "natural";
    detector.exit(reason === "user-kill" ? 0 : exitCode);
    send({ type: "pty:exit", terminalId: request.terminalId, exitCode, reason, at: Date.now() });
    sessions.delete(request.terminalId);
    sequence.delete(request.terminalId);
    detectors.delete(request.terminalId);
    oscParsers.delete(request.terminalId);
    agentTypes.delete(request.terminalId);
    // Keep the buffer after exit so a reconnecting renderer can still replay
    // the tail of the final output; it is released on explicit recreate.
  });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "shutdown") {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    void hookServer.close();
    for (const [terminalId, session] of sessions) {
      killRequests.add(terminalId);
      try { session.kill(); } catch { /* process is shutting down */ }
    }
    process.exit(0);
  }
  if (message.type === "pty:create") {
    createSession(message);
    return;
  }
  if (message.type === "pty:write") {
    try {
      const request = normalizeWriteRequest(message);
      const session = sessions.get(request.terminalId);
      const detector = detectors.get(request.terminalId);
      if (!session || !detector) throw protocolError("NOT_FOUND", `terminal does not exist: ${request.terminalId}`);
      session.write(request.data);
      if (message.launch === true) detector.launch?.();
      else detector.input(request.data);
      detector.tick();
    } catch (error) {
      sendError("pty:write", error, message.requestId, message?.terminalId);
    }
    return;
  }
  if (message.type === "pty:resize") {
    try {
      const request = normalizeResizeRequest(message);
      const session = sessions.get(request.terminalId);
      if (!session) throw protocolError("NOT_FOUND", `terminal does not exist: ${request.terminalId}`);
      session.resize(request.cols, request.rows);
    } catch (error) {
      sendError("pty:resize", error, message.requestId, message?.terminalId);
    }
    return;
  }
  if (message.type === "pty:kill") {
    try {
      const request = normalizeTerminalRequest(message, "pty:kill");
      const session = sessions.get(request.terminalId);
      if (!session) throw protocolError("NOT_FOUND", `terminal does not exist: ${request.terminalId}`);
      killRequests.add(request.terminalId);
      session.kill();
    } catch (error) {
      sendError("pty:kill", error, message.requestId, message?.terminalId);
    }
    return;
  }
  if (message.type === "pty:replay-request") {
    try {
      const request = normalizeTerminalRequest(message, "pty:replay-request");
      const fromSequence = Number(message.fromSequence);
      if (!Number.isInteger(fromSequence) || fromSequence < 0) {
        throw protocolError("INVALID_REQUEST", "fromSequence must be a non-negative integer", { field: "fromSequence" });
      }
      if (!buffers.has(request.terminalId) && !sessions.has(request.terminalId)) {
        throw protocolError("NOT_FOUND", `terminal does not exist: ${request.terminalId}`);
      }
      replay(request.terminalId, fromSequence);
    } catch (error) {
      sendError("pty:replay-request", error, message.requestId, message?.terminalId);
    }
    return;
  }
  if (message.type === "state:viewed") {
    try {
      detectors.get(normalizeTerminalRequest(message, "state:viewed").terminalId)?.viewed();
    } catch (error) {
      sendError("state:viewed", error, message.requestId, message?.terminalId);
    }
    return;
  }
  if (message.type === "state:rebuild-detector") {
    try {
      const request = normalizeTerminalRequest(message, "state:rebuild-detector");
      const agentType = typeof message.agentType === "string" ? message.agentType : "generic";
      if (!AGENT_TYPES.has(agentType)) {
        throw protocolError("INVALID_AGENT", `unsupported agent type: ${agentType}`, { field: "agentType" });
      }
      if (!detectors.has(request.terminalId)) {
        throw protocolError("NOT_FOUND", `terminal does not exist: ${request.terminalId}`);
      }
      makeDetector(request.terminalId, agentType);
      send({ type: "state:update", terminalId: request.terminalId, previous: "ready", current: "ready", confidence: 1, source: "user", summary: `detector rebuilt for ${agentType}`, at: Date.now() });
    } catch (error) {
      sendError("state:rebuild-detector", error, message.requestId, message?.terminalId);
    }
    return;
  }
  if (message.type === "state:hook") {
    try {
      const request = normalizeTerminalRequest(message, "state:hook");
      const detector = detectors.get(request.terminalId);
      if (detector && typeof message.event === "string" && typeof message.status === "string") detector.hook(message.event, message.status);
    } catch (error) {
      sendError("state:hook", error, message.requestId, message?.terminalId);
    }
  }
}

parentPort.on("message", (event) => {
  const message = event?.data || event;
  if (message?.type !== "connect") return;
  dataPort = event?.ports?.[0] || message?.ports?.[0];
  if (!dataPort) return;
  dataPort.on("message", (portEvent) => {
    try { handleMessage(portEvent.data); } catch (error) { sendError("message", error); }
  });
  dataPort.on("messageerror", (error) => sendError("data-port", error));
  dataPort.start();
  send({ type: "pty:host-ready", at: Date.now() });
});

// Start the detector clock as soon as the host module loads. It is independent
// of the data port so detection keeps advancing across renderer reconnects.
startTickLoop();
