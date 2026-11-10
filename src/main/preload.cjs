const { contextBridge, ipcRenderer } = require("electron");

let dataPort = null;
const queued = [];
const pendingCreates = new Map();
const replayNeeds = new Map();
const consumedSequences = new Map();
const outputStreams = new Map();
let activeFlowId = null;
const outputListeners = new Set();
const stateListeners = new Set();
const snapshotListeners = new Set();
const exitListeners = new Set();
const errorListeners = new Set();
const hostListeners = new Set();
const titleListeners = new Set();
const cwdListeners = new Set();
const agentListeners = new Set();
const sessionListeners = new Set();

// The host sends the state snapshot as soon as it attaches the port, which can
// be before React mounts and subscribes. Keep the last one so a late
// subscriber still learns the live detector state.
let latestSnapshot = null;

function send(message) {
  if (dataPort) {
    try {
      dataPort.postMessage(message);
      return;
    } catch {
      dataPort = null;
    }
  }
  queued.push(message);
  if (queued.length > 1000) queued.splice(0, queued.length - 1000);
}

function removeQueued(requestId) {
  if (!requestId) return;
  for (let index = queued.length - 1; index >= 0; index -= 1) {
    if (queued[index].requestId === requestId) queued.splice(index, 1);
  }
}

function rejectPendingCreates(reason) {
  const error = reason instanceof Error ? reason : Object.assign(new Error(reason?.message || "PTY host disconnected"), reason || {});
  for (const [requestId, pending] of pendingCreates) {
    clearTimeout(pending.timer);
    removeQueued(requestId);
    pending.reject(error);
  }
  pendingCreates.clear();
}

function handleDataMessage(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "pty:create-result" && payload.requestId) {
    const pending = pendingCreates.get(payload.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCreates.delete(payload.requestId);
      if (!payload.existing) {
        consumedSequences.delete(payload.terminalId);
        outputStreams.delete(payload.terminalId);
      }
      pending.resolve(payload);
    }
    return;
  }
  if (payload.type === "pty:error") {
    const error = Object.assign(new Error(payload.message || "PTY request failed"), payload);
    if (payload.requestId) {
      const pending = pendingCreates.get(payload.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCreates.delete(payload.requestId);
        removeQueued(payload.requestId);
        pending.reject(error);
      }
    }
    errorListeners.forEach((listener) => listener(payload));
    return;
  }
  if (payload.type === "pty:output") {
    if (payload.streamId && outputStreams.get(payload.terminalId) !== payload.streamId) {
      outputStreams.set(payload.terminalId, payload.streamId);
      consumedSequences.delete(payload.terminalId);
    }
    // Output can arrive before React subscribes. Release transport credits but
    // never call it consumed until xterm's write callback confirms parsing.
    if (outputListeners.size === 0) acknowledgeOutput(payload, false);
    outputListeners.forEach((listener) => listener(payload));
  }
  if (payload.type === "state:update") stateListeners.forEach((listener) => listener(payload));
  if (payload.type === "state:snapshot") {
    latestSnapshot = payload;
    snapshotListeners.forEach((listener) => listener(payload));
  }
  if (payload.type === "pty:exit") exitListeners.forEach((listener) => listener(payload));
  if (payload.type === "pty:title") titleListeners.forEach((listener) => listener(payload));
  if (payload.type === "pty:cwd") cwdListeners.forEach((listener) => listener(payload));
  if (payload.type === "pty:agent") agentListeners.forEach((listener) => listener(payload));
  if (payload.type === "session:update") sessionListeners.forEach((listener) => listener(payload));
  if (payload.type === "pty:host-ready") {
    activeFlowId = payload.flowId || null;
    hostListeners.forEach((listener) => listener(payload));
    // Renderer reconnected to a (possibly restarted) host: request replay of
    // any buffered output beyond what this renderer already consumed.
    if (replayNeeds.size > 0) {
      for (const [terminalId, fromSequence] of replayNeeds) {
        send({ type: "pty:replay-request", terminalId, fromSequence });
      }
      replayNeeds.clear();
    }
  }
}

function acknowledgeOutput(event, consumed = true) {
  if (!dataPort || !activeFlowId || event?.flowId !== activeFlowId) return;
  if (!Number.isSafeInteger(event.deliveryId) || !Number.isInteger(event.sequence)) return;
  if (consumed && (!event.streamId || outputStreams.get(event.terminalId) === event.streamId)) {
    consumedSequences.set(event.terminalId, Math.max(consumedSequences.get(event.terminalId) || 0, event.sequence));
  }
  // ACKs belong to one connection; never queue them across reconnects.
  try { dataPort.postMessage({ type: "pty:output-ack", flowId: activeFlowId, deliveryId: event.deliveryId }); } catch { /* reconnect will replay unconsumed output */ }
}

ipcRenderer.on("pty:connect", (_event) => {
  const nextPort = _event.ports[0];
  if (!nextPort) return;
  try { dataPort?.close(); } catch { /* old port may already be closed */ }
  dataPort = nextPort;
  activeFlowId = null;
  // A different host may own this port; never replay a snapshot from the old one.
  latestSnapshot = null;
  dataPort.onmessage = (messageEvent) => { if (dataPort === nextPort) handleDataMessage(messageEvent.data); };
  dataPort.onmessageerror = () => {
    if (dataPort !== nextPort) return;
    dataPort = null;
    activeFlowId = null;
    if (consumedSequences.size > 0) {
      for (const [terminalId, sequenceNumber] of consumedSequences) replayNeeds.set(terminalId, sequenceNumber);
    }
    hostListeners.forEach((listener) => listener({ type: "pty:host-disconnected", at: Date.now() }));
  };
  dataPort.start();
  queued.splice(0).forEach((message) => {
    try { dataPort?.postMessage(message); } catch { queued.push(message); }
  });
});

ipcRenderer.on("pty:host-exit", (_event, payload) => {
  dataPort = null;
  activeFlowId = null;
  if (payload?.type === "pty:host-disconnected") {
    for (const [terminalId, sequenceNumber] of consumedSequences) replayNeeds.set(terminalId, sequenceNumber);
  }
  queued.length = 0;
  rejectPendingCreates(Object.assign(new Error(payload?.message || "PTY host exited"), payload || {}));
  hostListeners.forEach((listener) => listener(payload));
});

contextBridge.exposeInMainWorld("termbeacon", {
  loadState: () => ipcRenderer.invoke("state:load"),
  scanCli: () => ipcRenderer.invoke("cli:scan"),
  planCli: (request) => ipcRenderer.invoke("cli:plan", request),
  executeCli: (request) => ipcRenderer.invoke("cli:execute", request),
  getCliLaunchSpec: (request) => ipcRenderer.invoke("cli:launch-spec", request),
  openCliDocs: (id) => ipcRenderer.invoke("cli:docs", id),
  onCliProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("cli:progress", handler);
    return () => ipcRenderer.removeListener("cli:progress", handler);
  },
  getPlatformInfo: () => ipcRenderer.invoke("platform:info"),
  readClipboardText: () => ipcRenderer.invoke("clipboard:read-text"),
  pickCwd: () => ipcRenderer.invoke("cwd:pick"),
  loadHistory: (terminalId) => ipcRenderer.invoke("history:load", terminalId),
  appendHistory: (terminalId, data) => ipcRenderer.invoke("history:append", terminalId, data),
  removeHistory: (terminalId) => ipcRenderer.invoke("history:remove", terminalId),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  getUpdateState: () => ipcRenderer.invoke("update:state"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  getResumeSpec: (request) => ipcRenderer.invoke("session:resume-spec", request),
  restartHost: (request) => ipcRenderer.invoke("pty:restart-host", request),
  saveState: (state) => ipcRenderer.invoke("state:save", state),
  createTerminal: (request) => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCreates.delete(requestId);
        removeQueued(requestId);
        const error = Object.assign(new Error("PTY creation timed out"), { code: "TIMEOUT", requestId, terminalId: request?.terminalId });
        reject(error);
        errorListeners.forEach((listener) => listener({
          type: "pty:error",
          operation: "pty:create",
          requestId,
          terminalId: request?.terminalId,
          code: error.code,
          message: error.message,
          at: Date.now(),
        }));
      }, 10000);
      pendingCreates.set(requestId, { resolve, reject, timer, terminalId: request?.terminalId });
      send({ type: "pty:create", requestId, ...request });
    });
  },
  write: (request) => send({ type: "pty:write", ...request }),
  launch: (request) => send({ type: "pty:write", ...request, launch: true }),
  resize: (request) => send({ type: "pty:resize", ...request }),
  replay: (request) => send({ type: "pty:replay-request", ...request }),
  acknowledgeOutput,
  forget: (terminalId) => {
    for (const [requestId, pending] of pendingCreates) {
      if (pending.terminalId !== terminalId) continue;
      clearTimeout(pending.timer);
      pendingCreates.delete(requestId);
      removeQueued(requestId);
      pending.reject(Object.assign(new Error("Terminal creation cancelled"), { code: "CANCELLED", terminalId }));
    }
    consumedSequences.delete(terminalId);
    outputStreams.delete(terminalId);
    replayNeeds.delete(terminalId);
    send({ type: "pty:forget", terminalId });
  },
  kill: (request) => send({ type: "pty:kill", ...request }),
  viewed: (terminalId) => send({ type: "state:viewed", terminalId }),
  rebuildDetector: (request) => send({ type: "state:rebuild-detector", ...request }),
  onSession: (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
  onOutput: (listener) => { outputListeners.add(listener); return () => outputListeners.delete(listener); },
  onState: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
  onSnapshot: (listener) => {
    snapshotListeners.add(listener);
    if (latestSnapshot) {
      try { listener(latestSnapshot); } catch { /* a broken listener must not break the bridge */ }
    }
    return () => snapshotListeners.delete(listener);
  },
  onExit: (listener) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
  onError: (listener) => { errorListeners.add(listener); return () => errorListeners.delete(listener); },
  onHost: (listener) => { hostListeners.add(listener); return () => hostListeners.delete(listener); },
  onTitle: (listener) => { titleListeners.add(listener); return () => titleListeners.delete(listener); },
  onCwd: (listener) => { cwdListeners.add(listener); return () => cwdListeners.delete(listener); },
  onAgent: (listener) => { agentListeners.add(listener); return () => agentListeners.delete(listener); },
  onUpdate: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("update:event", handler);
    return () => ipcRenderer.removeListener("update:event", handler);
  },
});
