const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const preloadSource = fs.readFileSync(path.join(root, "src", "main", "preload.cjs"), "utf8");
const app = fs.readFileSync(path.join(root, "src", "renderer", "App.tsx"), "utf8");
const types = fs.readFileSync(path.join(root, "src", "shared", "types.ts"), "utf8");

function loadPreload() {
  const ipcHandlers = new Map();
  const bridge = {};
  const ipcRenderer = {
    on(channel, handler) { ipcHandlers.set(channel, handler); },
    removeListener() {},
    invoke() { return Promise.resolve(); },
  };
  vm.runInNewContext(preloadSource, {
    require: (request) => {
      if (request === "electron") {
        return {
          contextBridge: { exposeInMainWorld: (name, api) => { bridge[name] = api; } },
          ipcRenderer,
        };
      }
      throw new Error(`unexpected require: ${request}`);
    },
    crypto,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: "preload.cjs" });
  return { api: bridge.termbeacon, ipcHandlers };
}

function connectPort(ipcHandlers) {
  const sent = [];
  const port = {
    postMessage: (message) => sent.push(message),
    start() {},
    close() {},
  };
  ipcHandlers.get("pty:connect")({ ports: [port] });
  return { port, sent };
}

test("shared types describe the host state snapshot", () => {
  assert.match(types, /export interface StateSnapshotEvent/);
  assert.match(types, /entries: StateSnapshotEntry\[\]/);
  assert.match(types, /export interface StateSnapshotEntry/);
  assert.match(types, /terminalId: string;\s*\n\s*state: AgentState;/);
});

test("preload forwards host state snapshots to the renderer", () => {
  const { api, ipcHandlers } = loadPreload();
  const { port } = connectPort(ipcHandlers);
  const snapshots = [];
  const dispose = api.onSnapshot((event) => snapshots.push(event));

  port.onmessage({
    data: { type: "state:snapshot", entries: [{ terminalId: "t1", state: "working", at: 5 }], at: 6 },
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].entries[0].state, "working");

  dispose();
  port.onmessage({ data: { type: "state:snapshot", entries: [], at: 7 } });
  assert.equal(snapshots.length, 1, "unsubscribed listeners must stop receiving snapshots");
});

test("preload replays the last snapshot to a late subscriber", () => {
  // The host attaches and sends the snapshot before React mounts, so a
  // subscription created afterwards would otherwise miss the only copy.
  const { api, ipcHandlers } = loadPreload();
  const { port } = connectPort(ipcHandlers);
  port.onmessage({
    data: { type: "state:snapshot", entries: [{ terminalId: "t1", state: "completed-unseen", at: 5 }], at: 6 },
  });

  const late = [];
  api.onSnapshot((event) => late.push(event));
  assert.equal(late.length, 1);
  assert.equal(late[0].entries[0].state, "completed-unseen");
});

test("preload keeps state updates flowing after a snapshot", () => {
  const { api, ipcHandlers } = loadPreload();
  const { port } = connectPort(ipcHandlers);
  const updates = [];
  api.onState((event) => updates.push(event));
  port.onmessage({
    data: { type: "state:update", terminalId: "t1", previous: "working", current: "completed-unseen", confidence: 0.9, source: "output", at: 9 },
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].current, "completed-unseen");
});

test("renderer declares and subscribes to the snapshot channel", () => {
  assert.match(app, /onSnapshot\(listener: \(event: StateSnapshotEvent\) => void\): \(\) => void;/);
  assert.match(app, /const disposeSnapshot = window\.termbeacon\.onSnapshot\(/);
  // The snapshot is the authoritative list of live host terminals, so it
  // replaces the map instead of merging into it.
  assert.match(app, /hostStates\.current = next;/);
  assert.match(app, /next\.set\(entry\.terminalId/);
  assert.match(app, /disposeSnapshot\(\)/);
});

test("renderer never fakes a healthy state when reattaching a live terminal", () => {
  // Regression: `existing ? item.state === "stopped" ? "ready" : item.state : "ready"`
  // forced every reattached terminal back to 就绪 and threw away the state the
  // host still held.
  assert.doesNotMatch(app, /existing \? item\.state === "stopped" \? "ready" : item\.state : "ready"/);
  const createBlock = app.match(/const result = await window\.termbeacon\.createTerminal\(\{([\s\S]*?)if \(existing\) \{/)?.[1];
  assert.ok(createBlock, "the create-result handler must exist");
  assert.match(createBlock, /const snapshot = hostStates\.current\.get\(terminal\.id\)/);
  assert.match(createBlock, /state: snapshot \? snapshot\.state : existing \? item\.state : "ready"/);
});

function outputEvent(sequence, overrides = {}) {
  return { type: "pty:output", terminalId: "t1", data: "x", sequence, streamId: "stream1", flowId: "flow1", deliveryId: sequence, ...overrides };
}

test("preload reconnects from parsed output instead of merely received output", () => {
  const { api, ipcHandlers } = loadPreload();
  const { port } = connectPort(ipcHandlers);
  api.onOutput(() => {});
  port.onmessage({ data: { type: "pty:host-ready", flowId: "flow1" } });
  port.onmessage({ data: outputEvent(1) });
  port.onmessage({ data: outputEvent(2) });
  api.acknowledgeOutput(outputEvent(1));
  port.onmessageerror();
  const next = connectPort(ipcHandlers);
  next.port.onmessage({ data: { type: "pty:host-ready", flowId: "flow2" } });
  const replay = next.sent.find((m) => m.type === "pty:replay-request");
  assert.equal(replay.fromSequence, 1);
});

test("stale renderer callbacks never ACK output on a newer connection", () => {
  const { api, ipcHandlers } = loadPreload();
  const first = connectPort(ipcHandlers);
  api.onOutput(() => {});
  first.port.onmessage({ data: { type: "pty:host-ready", flowId: "flow1" } });
  first.port.onmessage({ data: outputEvent(1) });
  const next = connectPort(ipcHandlers);
  next.port.onmessage({ data: { type: "pty:host-ready", flowId: "flow2" } });
  api.acknowledgeOutput(outputEvent(1));
  assert.equal(next.sent.some((m) => m.type === "pty:output-ack"), false);
  first.port.onmessageerror();
  next.port.onmessage({ data: outputEvent(2, { flowId: "flow2" }) });
  api.acknowledgeOutput(outputEvent(2, { flowId: "flow2" }));
  assert.equal(next.sent.filter((m) => m.type === "pty:output-ack").length, 1);
});

test("output without a mounted consumer releases credit without advancing parsed sequence", () => {
  const { api, ipcHandlers } = loadPreload();
  const { port, sent } = connectPort(ipcHandlers);
  port.onmessage({ data: { type: "pty:host-ready", flowId: "flow1" } });
  port.onmessage({ data: outputEvent(1) });
  assert.equal(sent.at(-1).type, "pty:output-ack");
  port.onmessageerror();
  const next = connectPort(ipcHandlers);
  next.port.onmessage({ data: { type: "pty:host-ready", flowId: "flow2" } });
  assert.equal(next.sent.some((m) => m.type === "pty:replay-request"), false);
  api.forget("t1");
  assert.equal(next.sent.at(-1).type, "pty:forget");
});

test("callbacks from an old PTY incarnation cannot advance the new stream's replay position", () => {
  const { api, ipcHandlers } = loadPreload();
  const { port } = connectPort(ipcHandlers);
  api.onOutput(() => {});
  port.onmessage({ data: { type: "pty:host-ready", flowId: "flow1" } });
  const old = outputEvent(100);
  const current = outputEvent(1, { streamId: "stream2", deliveryId: 101 });
  port.onmessage({ data: old });
  port.onmessage({ data: current });
  api.acknowledgeOutput(current);
  api.acknowledgeOutput(old);
  port.onmessageerror();
  const next = connectPort(ipcHandlers);
  next.port.onmessage({ data: { type: "pty:host-ready", flowId: "flow2" } });
  assert.equal(next.sent.find((m) => m.type === "pty:replay-request").fromSequence, 1);
});

test("forget cancels queued creations before a renderer port is connected", async () => {
  const { api, ipcHandlers } = loadPreload();
  const creating = api.createTerminal({ terminalId: "cancelled" });
  const cancelled = assert.rejects(creating, { code: "CANCELLED" });
  api.forget("cancelled");
  await cancelled;
  const { sent } = connectPort(ipcHandlers);
  assert.equal(sent.some((m) => m.type === "pty:create"), false);
  assert.equal(sent.at(-1).type, "pty:forget");
});
