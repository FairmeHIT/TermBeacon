const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const hostSource = fs.readFileSync(path.join(__dirname, "..", "src", "main", "pty-host.cjs"), "utf8");
const validation = require("../src/main/pty-validation.cjs");

function createHarness({ spawn, detection } = {}) {
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
    port: 12345,
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
  vm.runInNewContext(hostSource, {
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
  }, { filename: "pty-host.cjs" });
  parentPort.emit("message", { data: { type: "connect" }, ports: [dataPort] });
  return { dataPort, messages, spawned, spawnedOptions, tick: () => tickCallback?.(), emitHook: (payload) => hookHandler?.(payload) };
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

test("PTY host rejects duplicate terminal creation", () => {
  const { dataPort, messages } = createHarness();
  dataPort.emit("message", { data: createMessage("t1") });
  dataPort.emit("message", { data: createMessage("t1", "another-shell.exe") });
  assert.equal(messages.find((message) => message.type === "pty:create-result")?.terminalId, "t1");
  assert.equal(messages.find((message) => message.type === "pty:error")?.code, "ALREADY_EXISTS");
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
  const { dataPort, emitHook } = createHarness({
    detection: {
      createDetector: () => ({
        output() {}, tick() {}, input() {}, exit() {}, viewed() {},
        hook(event, status) { hooks.push([event, status]); },
      }),
    },
  });
  dataPort.emit("message", { data: createMessage("t1") });
  emitHook({ terminalId: "t1", event: "session.status", status: "completed" });
  emitHook({ terminalId: "missing", event: "session.status", status: "completed" });
  assert.deepEqual(hooks, [["session.status", "completed"]]);
});
