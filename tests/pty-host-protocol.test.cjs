const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const hostSource = fs.readFileSync(path.join(__dirname, "..", "src", "main", "pty-host.cjs"), "utf8");
const validation = require("../src/main/pty-validation.cjs");

function createHarness({ spawn } = {}) {
  const parentPort = new EventEmitter();
  const dataPort = new EventEmitter();
  const messages = [];
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
  const fakeFs = { statSync: () => ({ isDirectory: () => true }) };
  const fakeDetection = { createDetector: () => ({ output() {}, tick() {}, input() {}, exit() {}, viewed() {}, hook() {} }) };
  const fakeProcess = {
    parentPort,
    env: {},
    cwd: () => process.cwd(),
    exit() {},
  };
  const fakeRequire = (request) => {
    if (request === "electron") return { parentPort };
    if (request === "node:fs") return fakeFs;
    if (request === "node-pty") return fakePty;
    if (request === "./detection-engine.cjs") return fakeDetection;
    if (request === "./pty-validation.cjs") return validation;
    if (request === "./platform.cjs") return require("../src/main/platform.cjs");
    throw new Error(`unexpected require: ${request}`);
  };
  vm.runInNewContext(hostSource, { require: fakeRequire, process: fakeProcess, console, Date, Error, Map, Set, Number, Object, String, Array }, { filename: "pty-host.cjs" });
  parentPort.emit("message", { data: { type: "connect" }, ports: [dataPort] });
  return { dataPort, messages };
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
