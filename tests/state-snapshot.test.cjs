const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const preloadSource = fs.readFileSync(path.join(root, "src", "main", "preload.cjs"), "utf8");
const app = fs.readFileSync(path.join(root, "src", "renderer", "App.tsx"), "utf8");
const types = fs.readFileSync(path.join(root, "src", "shared", "types.ts"), "utf8");

function loadPreload(timers = {}) {
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
    setTimeout: timers.setTimeout || setTimeout,
    clearTimeout: timers.clearTimeout || clearTimeout,
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

test("cold-start PTY creation is serialized instead of timing out in the host queue", async () => {
  // Regression: after an update the host owns no PTYs, so every terminal is
  // created at once. The host spawns synchronously; requests queued behind
  // dozens of spawns hit the old 10 s timeout, were reported as errors, and
  // never reached the post-create auto-resume path even though the PTY existed.
  const { api, ipcHandlers } = loadPreload();
  const { port, sent } = connectPort(ipcHandlers);
  const creates = () => sent.filter((message) => message.type === "pty:create");

  const first = api.createTerminal({ terminalId: "t1" });
  const second = api.createTerminal({ terminalId: "t2" });
  assert.equal(creates().length, 1, "only one create may be in flight");
  assert.equal(creates()[0].terminalId, "t1");

  port.onmessage({ data: { type: "pty:create-result", requestId: creates()[0].requestId, terminalId: "t1", ok: true } });
  await first;
  assert.equal(creates().length, 2, "the next create starts after the first result");
  assert.equal(creates()[1].terminalId, "t2");

  port.onmessage({ data: { type: "pty:create-result", requestId: creates()[1].requestId, terminalId: "t2", ok: true } });
  await second;
});

test("a priority create jumps ahead of queued background restores", async () => {
  const { api, ipcHandlers } = loadPreload();
  const { port, sent } = connectPort(ipcHandlers);
  const creates = () => sent.filter((message) => message.type === "pty:create");

  const first = api.createTerminal({ terminalId: "active" });
  const second = api.createTerminal({ terminalId: "background-1" });
  const third = api.createTerminal({ terminalId: "background-2" });
  const fourth = api.createTerminal({ terminalId: "background-3" });
  assert.equal(creates().length, 1);
  assert.equal(creates()[0].terminalId, "active");

  port.onmessage({ data: { type: "pty:create-result", requestId: creates()[0].requestId, terminalId: "active", ok: true } });
  await first;
  // background-1 was already in flight; the rest can still be reordered.
  assert.equal(creates()[1].terminalId, "background-1");
  api.prioritizeCreate("background-3");
  port.onmessage({ data: { type: "pty:create-result", requestId: creates()[1].requestId, terminalId: "background-1", ok: true } });
  await second;
  assert.equal(creates()[2].terminalId, "background-3", "the terminal the user switched to must start next");

  const clicked = api.createTerminal({ terminalId: "new-terminal" }, { priority: true });
  port.onmessage({ data: { type: "pty:create-result", requestId: creates()[2].requestId, terminalId: "background-3", ok: true } });
  await fourth;
  assert.equal(creates()[3].terminalId, "new-terminal", "a new terminal must not wait for background restores");
  port.onmessage({ data: { type: "pty:create-result", requestId: creates()[3].requestId, terminalId: "new-terminal", ok: true } });
  await clicked;
  port.onmessage({ data: { type: "pty:create-result", requestId: creates()[4].requestId, terminalId: "background-2", ok: true } });
  await third;
});

test("a new data plane re-sends the create that was waiting on the old one", async () => {
  const { api, ipcHandlers } = loadPreload();
  const first = connectPort(ipcHandlers);
  const creating = api.createTerminal({ terminalId: "reconnect" });
  assert.equal(first.sent.filter((message) => message.type === "pty:create").length, 1);

  const second = connectPort(ipcHandlers);
  const resent = second.sent.filter((message) => message.type === "pty:create");
  assert.equal(resent.length, 1, "the in-flight create must survive a data-plane reconnect");
  assert.equal(resent[0].terminalId, "reconnect");
  second.port.onmessage({ data: { type: "pty:create-result", requestId: resent[0].requestId, terminalId: "reconnect", existing: true, ok: true } });
  await creating;
});

test("a create timeout starts only after the request reaches the host", () => {
  const timers = [];
  const { api, ipcHandlers } = loadPreload({
    setTimeout: (callback) => {
      const handle = { callback, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => { if (handle) handle.cleared = true; },
  });

  const creating = api.createTerminal({ terminalId: "queued" });
  creating.catch(() => {});
  assert.equal(timers.length, 0, "a request waiting for the data plane must not age out");

  const { sent } = connectPort(ipcHandlers);
  assert.equal(timers.length, 1, "the watchdog starts when the request is sent");
  assert.equal(sent.filter((message) => message.type === "pty:create").length, 1);
});

test("a create result that arrives after the timeout kills the orphaned PTY", async () => {
  const timers = [];
  const { api, ipcHandlers } = loadPreload({
    setTimeout: (callback) => {
      const handle = { callback };
      timers.push(handle);
      return handle;
    },
    clearTimeout: () => {},
  });
  const { port, sent } = connectPort(ipcHandlers);
  const creating = api.createTerminal({ terminalId: "late" });
  const failed = assert.rejects(creating, { code: "TIMEOUT" });
  timers[0].callback();
  await failed;

  port.onmessage({ data: { type: "pty:create-result", requestId: sent.find((message) => message.type === "pty:create").requestId, terminalId: "late", ok: true } });
  assert.equal(sent.at(-1).type, "pty:forget");
  assert.equal(sent.at(-1).terminalId, "late");
});
