const { contextBridge, ipcRenderer } = require("electron");

let dataPort = null;
const queued = [];
const pendingCreates = new Map();
const replayNeeds = new Map();
const consumedSequences = new Map();
const outputListeners = new Set();
const stateListeners = new Set();
const exitListeners = new Set();
const errorListeners = new Set();
const hostListeners = new Set();

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
    if (typeof payload.terminalId === "string" && Number.isInteger(payload.sequence)) {
      consumedSequences.set(payload.terminalId, Math.max(consumedSequences.get(payload.terminalId) || 0, payload.sequence));
    }
    outputListeners.forEach((listener) => listener(payload));
  }
  if (payload.type === "state:update") stateListeners.forEach((listener) => listener(payload));
  if (payload.type === "pty:exit") exitListeners.forEach((listener) => listener(payload));
  if (payload.type === "pty:host-ready") {
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

ipcRenderer.on("pty:connect", (_event) => {
  const nextPort = _event.ports[0];
  if (!nextPort) return;
  try { dataPort?.close(); } catch { /* old port may already be closed */ }
  dataPort = nextPort;
  dataPort.onmessage = (messageEvent) => handleDataMessage(messageEvent.data);
  dataPort.onmessageerror = () => {
    dataPort = null;
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
  queued.length = 0;
  rejectPendingCreates(Object.assign(new Error(payload?.message || "PTY host exited"), payload || {}));
  hostListeners.forEach((listener) => listener(payload));
});

contextBridge.exposeInMainWorld("termbeacon", {
  loadState: () => ipcRenderer.invoke("state:load"),
  discoverCli: () => ipcRenderer.invoke("cli:discover"),
  pickCwd: () => ipcRenderer.invoke("cwd:pick"),
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
      pendingCreates.set(requestId, { resolve, reject, timer });
      send({ type: "pty:create", requestId, ...request });
    });
  },
  write: (request) => send({ type: "pty:write", ...request }),
  resize: (request) => send({ type: "pty:resize", ...request }),
  replay: (request) => send({ type: "pty:replay-request", ...request }),
  kill: (request) => send({ type: "pty:kill", ...request }),
  viewed: (terminalId) => send({ type: "state:viewed", terminalId }),
  rebuildDetector: (request) => send({ type: "state:rebuild-detector", ...request }),
  onOutput: (listener) => { outputListeners.add(listener); return () => outputListeners.delete(listener); },
  onState: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
  onExit: (listener) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
  onError: (listener) => { errorListeners.add(listener); return () => errorListeners.delete(listener); },
  onHost: (listener) => { hostListeners.add(listener); return () => hostListeners.delete(listener); },
});
