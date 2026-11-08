const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const hostSource = fs.readFileSync(path.join(__dirname, "..", "src", "main", "pty-host.cjs"), "utf8");
const validation = require("../src/main/pty-validation.cjs");

function createHarness({ spawn, detection, hookPort = 12345 } = {}) {
  const parentPort = new EventEmitter();
  const dataPort = new EventEmitter();
  const messages = [];
  let tickCallback = null;
  dataPort.postMessage = (message) => messages.push(message);
  dataPort.start = () => {};

  const defaultSpawn = () => {
    const session = {
      pid: 4321,
      onData(callback) { this.dataCallback = callback; },
      onExit(callback) { this.exitCallback = callback; },
      write() {},
      resize() {},
      pauses: 0,
      resumes: 0,
      pause() { this.pauses += 1; },
      resume() { this.resumes += 1; },
      kill() { this.exitCallback?.({ exitCode: 0 }); },
    };
    return session;
  };
  const fakePty = { spawn: spawn || defaultSpawn };
  const spawned = [];
  const spawnedOptions = [];
  let hookHandler = null;
  const wrappedSpawn = (shell, args, options) => {
    const session = fakePty.spawn(shell, args, options);
    spawned.push(session);
    spawnedOptions.push(options);
    return session;
  };
  const fakeFs = { statSync: () => ({ isDirectory: () => true }) };
  const fakeDetection = detection || { createDetector: () => ({ output() {}, tick() {}, input() {}, exit() {}, viewed() {}, hook() {} }) };
  const fakeHookServer = {
    start: () => Promise.resolve(12345),
    close: () => Promise.resolve(),
    port: hookPort,
    token: "test-token",
  };
  const fakeHookModule = {
    createHookServer: ({ onEvent }) => {
      hookHandler = onEvent;
      return fakeHookServer;
    },
  };
  const fakeProcess = {
    parentPort,
    env: {},
    cwd: () => process.cwd(),
    exit() {},
  };
  const fakeRequire = (request) => {
    if (request === "electron") return { parentPort };
    if (request === "node:fs") return fakeFs;
    if (request === "node:crypto") return require(request);
    if (request === "node-pty") return { spawn: wrappedSpawn };
    if (request === "./detection-engine.cjs") return fakeDetection;
    if (request === "./hook-server.cjs") return fakeHookModule;
    if (request === "./pty-validation.cjs") return validation;
    // Any other local module is loaded for real. Keeping this generic means a
    // newly added runtime module does not require touching the harness, which
    // previously caused false failures (and hid a real packaging bug).
    if (request.startsWith("./") && request.endsWith(".cjs")) {
      return require(path.join(__dirname, "..", "src", "main", request.slice(2)));
    }
    throw new Error(`unexpected require: ${request}`);
  };
  const fakeSetInterval = (callback) => {
    tickCallback = callback;
    return { unref() {} };
  };
  const context = vm.createContext({
    require: fakeRequire,
    process: fakeProcess,
    console,
    Date,
    Error,
    Map,
    Set,
    Number,
    Object,
    String,
    Array,
    Buffer,
    setInterval: fakeSetInterval,
    clearInterval: () => { tickCallback = null; },
  });
  vm.runInContext(hostSource, context, { filename: "pty-host.cjs" });
  parentPort.emit("message", { data: { type: "connect" }, ports: [dataPort] });
  // Reconnecting client (renderer reload / app restart): the host keeps every
  // session and attaches a brand new port. Returns that port's own messages.
  const reattach = () => {
    const nextPort = new EventEmitter();
    const nextMessages = [];
    nextPort.postMessage = (message) => nextMessages.push(message);
    nextPort.start = () => {};
    parentPort.emit("message", { data: { type: "connect" }, ports: [nextPort] });
    return nextMessages;
  };
  return { dataPort, messages, spawned, spawnedOptions, reattach, context, tick: () => tickCallback?.(), emitHook: (payload) => hookHandler?.(payload) };
}

function createMessage(terminalId, shell = "cmd.exe") {
  return {
    type: "pty:create",
    requestId: `request-${terminalId}`,
    terminalId,
    title: terminalId,
    cwd: process.cwd(),
    shell,
    args: [],
    cols: 80,
    rows: 24,
    agentType: "generic",
  };
}

test("PTY host buffers output and replays beyond a requested sequence", () => {
  const { dataPort, messages, spawned } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  const session = spawned[0];
  session.dataCallback("chunk1");
  session.dataCallback("chunk2");
  session.dataCallback("chunk3");
  dataPort.emit("message", { data: { type: "pty:replay-request", terminalId: "t1", fromSequence: 1 } });
  const replayed = messages.filter((message) => message.type === "pty:output" && message.replay);
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].data, "chunk2");
  assert.equal(replayed[0].sequence, 2);
  assert.equal(replayed[1].data, "chunk3");
  assert.equal(replayed[1].sequence, 3);
});

test("PTY host replay from zero resends the full buffer", () => {
  const { dataPort, messages, spawned } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  const session = spawned[0];
  session.dataCallback("one");
  dataPort.emit("message", { data: { type: "pty:replay-request", terminalId: "t1", fromSequence: 0 } });
  const replayed = messages.filter((message) => message.type === "pty:output" && message.replay);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].data, "one");
});

test("PTY host rejects replay requests with invalid sequence or unknown terminal", () => {
  const { dataPort, messages } = createHarness();
  dataPort.emit("message", { data: { type: "pty:replay-request", terminalId: "ghost", fromSequence: 0 } });
  dataPort.emit("message", { data: { type: "pty:replay-request", terminalId: "ghost", fromSequence: -1 } });
  const errors = messages.filter((message) => message.type === "pty:error" && message.operation === "pty:replay-request");
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.code === "NOT_FOUND"));
  assert.ok(errors.some((error) => error.code === "INVALID_REQUEST"));
});

test("PTY host reattaches an existing terminal after client reconnect", () => {
  const { dataPort, messages } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: createMessage("t1", "another-shell.exe") });
  const results = messages.filter((message) => message.type === "pty:create-result");
  assert.equal(results.length, 2);
  assert.equal(results[1].terminalId, "t1");
  assert.equal(results[1].existing, true);
  assert.equal(messages.some((message) => message.type === "pty:error"), false);
});

test("PTY host detaches the client without killing sessions", () => {
  const { dataPort, spawned, messages } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: { type: "detach" } });
  assert.equal(spawned.length, 1);
  assert.equal(messages.some((message) => message.type === "pty:exit"), false);
});

test("PTY host returns spawn failures as structured errors", () => {
  const { dataPort, messages } = createHarness({ spawn: () => { throw new Error("shell launch failed"); } });
  dataPort.emit("message", { data: createMessage("t1", "broken-shell.exe") });
  const error = messages.find((message) => message.type === "pty:error");
  assert.equal(error.operation, "pty:create");
  assert.equal(error.requestId, "request-t1");
  assert.match(error.message, /shell launch failed/);
});

test("PTY host rebuilds a detector when the agent type changes", () => {
  const { dataPort, messages } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: { type: "state:rebuild-detector", terminalId: "t1", agentType: "claude" } });
  const update = messages.find((message) => message.type === "state:update" && /detector rebuilt/.test(message.summary || ""));
  assert.equal(update.terminalId, "t1");
  assert.equal(update.current, "ready");
  assert.equal(messages.find((message) => message.type === "pty:error" && message.operation === "state:rebuild-detector"), undefined);
});

test("PTY host rejects detector rebuilds for unknown terminals or agent types", () => {
  const { dataPort, messages } = createHarness();
  dataPort.emit("message", { data: { type: "state:rebuild-detector", terminalId: "missing", agentType: "claude" } });
  dataPort.emit("message", { data: { type: "state:rebuild-detector", terminalId: "missing", agentType: "not-an-agent" } });
  const errors = messages.filter((message) => message.type === "pty:error" && message.operation === "state:rebuild-detector");
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.code === "NOT_FOUND"));
  assert.ok(errors.some((error) => error.code === "INVALID_AGENT"));
});

test("PTY host advances detectors on a timer without new output", () => {
  let ticks = 0;
  const { dataPort, tick } = createHarness({
    detection: {
      createDetector: () => ({ output() {}, tick() { ticks += 1; }, input() {}, exit() {}, viewed() {}, hook() {} }),
    },
  });
  dataPort.emit("message", { data: createMessage("t1") });
  tick();
  tick();
  assert.equal(ticks, 2);
});

test("PTY host treats agent launch writes as launch, not task input", () => {
  let launches = 0;
  let inputs = 0;
  const { dataPort } = createHarness({
    detection: {
      createDetector: () => ({ output() {}, tick() {}, input() { inputs += 1; }, launch() { launches += 1; }, exit() {}, viewed() {}, hook() {} }),
    },
  });
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: { type: "pty:write", terminalId: "t1", data: "claude\r", launch: true } });
  assert.equal(launches, 1);
  assert.equal(inputs, 0);
});

test("PTY host switches output to the detected agent and clears generic launch state", () => {
  const outputCalls = [];
  const instances = [];
  const detection = {
    createDetector(agentType, emit) {
      const runtime = { state: "ready" };
      const detector = {
        runtime,
        output(data) { outputCalls.push({ agentType, data }); },
        tick() {},
        input() {
          runtime.state = "working";
          emit({ previous: "ready", current: "working", confidence: 0.55, source: "user", at: Date.now() });
        },
        exit() {},
        viewed() {},
        hook() {},
      };
      instances.push({ agentType, detector });
      return detector;
    },
  };
  const { dataPort, messages, spawned } = createHarness({ detection });
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: { type: "pty:write", terminalId: "t1", data: "claude\r" } });
  spawned[0].dataCallback("Claude Code\r\n");

  const stateUpdates = messages.filter((message) => message.type === "state:update");
  assert.equal(instances.map((entry) => entry.agentType).join(","), "generic,claude");
  assert.equal(outputCalls.at(-1).agentType, "claude");
  assert.equal(stateUpdates.at(-1).current, "ready");
  assert.equal(stateUpdates.at(-1).source, "agent");
});

test("PTY host injects the hook bridge env into each session", () => {
  const { dataPort, spawnedOptions } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  const env = spawnedOptions[0].env;
  assert.equal(env.TERMBEACON_TERMINAL_ID, "t1");
  assert.equal(env.TERMBEACON_HOOK_PORT, "12345");
  assert.equal(env.TERMBEACON_HOOK_TOKEN, "test-token");
});

test("PTY host routes bridge events to the terminal detector", () => {
  const hooks = [];
  const { dataPort, messages, emitHook } = createHarness({
    detection: {
      createDetector: () => ({
        output() {}, tick() {}, input() {}, exit() {}, viewed() {},
        hook(event, status) { hooks.push([event, status]); },
      }),
    },
  });
  dataPort.emit("message", { data: createMessage("t1") });
  emitHook({ terminalId: "t1", event: "session.status", status: "completed", sessionId: "session-1" });
  emitHook({ terminalId: "missing", event: "session.status", status: "completed" });
  assert.deepEqual(hooks, [["session.status", "completed"]]);
  const sessionUpdate = messages.find((message) => message.type === "session:update");
  assert.equal(sessionUpdate?.terminalId, "t1");
  assert.equal(sessionUpdate?.sessionId, "session-1");
});

test("native status received before an agent banner survives detector upgrade", () => {
  const { dataPort, spawned, messages, emitHook, reattach } = createHarness({ detection: require("../src/main/detection-engine.cjs") });
  dataPort.emit("message", { data: createMessage("t1") });
  emitHook({ terminalId: "t1", event: "PermissionRequest", status: "waiting", sessionId: "main", occurredAt: 2000 });
  spawned[0].dataCallback("Claude Code\r\n\x1b]0;◐ Claude Code\x07");
  assert.equal(messages.filter((event) => event.type === "state:update").at(-1).current, "awaiting-input");
  assert.equal(reattach().find((event) => event.type === "state:snapshot").entries[0].state, "awaiting-input");
  // A stale retry must not replace the session id used by resume.
  emitHook({ terminalId: "t1", event: "UserPromptSubmit", status: "running", sessionId: "old", occurredAt: 1000 });
  assert.equal(messages.filter((event) => event.type === "session:update").at(-1).sessionId, "main");
});

// Detector stub that walks ready -> working -> stopped on the same terminal so
// the host has a real state history to snapshot.
function scriptedDetection() {
  return {
    createDetector(agentType, emit) {
      const runtime = { state: "ready" };
      return {
        runtime,
        output() {},
        tick() {},
        input() {
          runtime.state = "working";
          emit({ previous: "ready", current: "working", confidence: 0.55, source: "user", summary: "npm test", at: 1000 });
        },
        exit(exitCode) {
          runtime.state = exitCode === 0 ? "stopped" : "error";
          emit({ previous: "working", current: runtime.state, confidence: 1, source: "process", at: 2000 });
        },
        viewed() {},
        hook() {},
      };
    },
  };
}

test("PTY host publishes a ready baseline in the snapshot for a fresh terminal", () => {
  const { dataPort, reattach } = createHarness({ detection: scriptedDetection() });
  dataPort.emit("message", { data: createMessage("t1") });
  const snapshot = reattach().find((message) => message.type === "state:snapshot");
  assert.ok(snapshot, "a reconnecting client must receive a state snapshot");
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].terminalId, "t1");
  assert.equal(snapshot.entries[0].state, "ready");
  assert.equal(typeof snapshot.entries[0].at, "number");
});

test("PTY host sends the live detector state to a reconnecting client", () => {
  // The renderer can reload while the host keeps the PTY alive. Without this
  // snapshot the sidebar has no way to recover the real state and fakes "就绪".
  const { dataPort, reattach } = createHarness({ detection: scriptedDetection() });
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: { type: "pty:write", terminalId: "t1", data: "npm test\r" } });

  const next = reattach();
  const readyIndex = next.findIndex((message) => message.type === "pty:host-ready");
  const snapshotIndex = next.findIndex((message) => message.type === "state:snapshot");
  assert.ok(readyIndex >= 0, "the reconnect still starts with pty:host-ready");
  assert.ok(snapshotIndex > readyIndex, "the snapshot must follow pty:host-ready");
  const snapshot = next[snapshotIndex];
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].terminalId, "t1");
  assert.equal(snapshot.entries[0].state, "working");
  assert.equal(snapshot.entries[0].summary, "npm test");
});

test("PTY host drops a terminal from the state snapshot once it exits", () => {
  const { dataPort, spawned, reattach } = createHarness({ detection: scriptedDetection() });
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: { type: "pty:write", terminalId: "t1", data: "npm test\r" } });
  spawned[0].exitCallback({ exitCode: 0 });

  const snapshot = reattach().find((message) => message.type === "state:snapshot");
  assert.ok(snapshot, "a snapshot is still sent");
  assert.equal(snapshot.entries.length, 0);
});

test("permanently forgotten terminals release cached output and ignore late PTY callbacks", () => {
  const { dataPort, spawned, messages, context } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  spawned[0].dataCallback("x".repeat(2 * 1024 * 1024));
  dataPort.emit("message", { data: { type: "pty:forget", terminalId: "t1" } });
  spawned[0].dataCallback("late data after kill");
  assert.equal(vm.runInContext("buffers.size + sessions.size + stateSnapshots.size", context), 0);
  dataPort.emit("message", { data: { type: "pty:replay-request", terminalId: "t1", fromSequence: 0 } });
  assert.equal(messages.at(-1).code, "NOT_FOUND");
});

test("exited output remains replayable with its original sequence until forgotten", () => {
  const { dataPort, spawned, messages } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  spawned[0].dataCallback("before exit");
  spawned[0].exitCallback({ exitCode: 0 });
  dataPort.emit("message", { data: { type: "pty:replay-request", terminalId: "t1", fromSequence: 0 } });
  const replayed = messages.filter((m) => m.type === "pty:output" && m.replay);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].sequence, 1);
  assert.equal(replayed[0].data, "before exit");
  dataPort.emit("message", { data: { type: "pty:forget", terminalId: "t1" } });
  assert.equal(messages.some((m) => m.operation === "pty:forget" && m.type === "pty:error"), false);
});

test("exited buffers have a global budget and expire without recreating their IDs", () => {
  const { dataPort, spawned, context } = createHarness();
  for (let i = 0; i < 12; i += 1) {
    dataPort.emit("message", { data: createMessage(`t${i}`) });
    spawned[i].dataCallback("x".repeat(2 * 1024 * 1024));
    spawned[i].exitCallback({ exitCode: 0 });
  }
  assert.ok(vm.runInContext("[...buffers.values()].reduce((n, entry) => n + entry.bytes, 0) <= EXITED_BUFFER_LIMIT_BYTES", context));
  vm.runInContext("pruneExitedBuffers(Date.now() + EXITED_BUFFER_TTL_MS)", context);
  assert.equal(vm.runInContext("buffers.size", context), 0);
});

test("PTY backpressure waits for parsing ACKs and detach resumes background work", () => {
  const { dataPort, spawned, messages, tick, context } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  spawned[0].dataCallback("x".repeat(1024 * 1024));
  assert.equal(spawned[0].pauses, 1);
  const initial = messages.filter((m) => m.type === "pty:output");
  assert.equal(initial.reduce((sum, m) => sum + m.data.length, 0), 512 * 1024);
  for (const output of initial) dataPort.emit("message", { data: { type: "pty:output-ack", flowId: output.flowId, deliveryId: output.deliveryId } });
  assert.equal(messages.filter((m) => m.type === "pty:output").length, 64);
  assert.equal(vm.runInContext("pausedSessions.size", context), 1);
  tick();
  dataPort.emit("message", { data: { type: "client:detach" } });
  assert.equal(spawned[0].resumes, 1);
  assert.equal(vm.runInContext("pausedSessions.size", context), 0);
});

test("large Unicode output is bounded, preserves characters and no longer builds per-chunk summaries", () => {
  const { dataPort, spawned, messages, context } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  const text = "中🙂".repeat(300000);
  spawned[0].dataCallback(text);
  let offset = 0;
  while (offset < messages.length) {
    const m = messages[offset++];
    if (m.type === "pty:output") dataPort.emit("message", { data: { type: "pty:output-ack", flowId: m.flowId, deliveryId: m.deliveryId } });
  }
  const output = messages.filter((m) => m.type === "pty:output");
  assert.equal(output.map((m) => m.data).join(""), text);
  assert.ok(output.every((m) => m.data.length <= 16384 && m.summary === undefined));
  assert.ok(output.every((m) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(m.data)));
  assert.ok(vm.runInContext("buffers.get('t1').bytes <= OUTPUT_BUFFER_LIMIT_BYTES", context));
});

test("forget cancels a PTY creation waiting for the hook server", async () => {
  const { dataPort, spawned } = createHarness({ hookPort: 0 });
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: { type: "pty:forget", terminalId: "t1" } });
  await Promise.resolve();
  assert.equal(spawned.length, 0);
});
