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
