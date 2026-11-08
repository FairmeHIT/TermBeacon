const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["queueHostMessage", "sendHostMessage", "flushHostMessages", "attachHostSocket"]);
const functions = tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(tree)).join("\n");
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const received = [], connections = [];
  const context = vm.createContext({
    hostSocket: null, hostSocketBlocked: false, hostMessageQueue: [], hostStartedAt: 0,
    rendererReady: true, rendererPort: { postMessage: m => received.push(m) },
    hostRestartAttempts: 0, MAX_HOST_MESSAGE_BYTES: 4 * 1024 * 1024,
    Buffer, console, isQuitting: false,
    connectDataPlane: () => connections.push("new renderer port"),
    notifyHostEvent() {}, schedulePtyHostRestart() {},
  });
  vm.runInContext(compiled, context);
  return { context, received, connections };
}

function socket() {
  const value = new EventEmitter();
  value.writes = [];
  value.writable = true;
  value.destroyed = false;
  value.ready = true;
  value.setEncoding = () => {};
  value.destroy = () => { value.destroyed = true; };
  value.write = line => { value.writes.push(JSON.parse(line)); return value.ready; };
  return value;
}

test("main creates a fresh renderer port when its host socket reconnects", () => {
  const { context, connections, received } = harness();
  const old = socket(), next = socket();
  context.attachHostSocket(old);
  context.attachHostSocket(next);
  assert.equal(connections.length, 2);
  old.emit("close");
  old.emit("data", JSON.stringify({ type: "stale" }) + "\n");
  next.emit("data", JSON.stringify({ type: "fresh" }) + "\n");
  assert.equal(context.hostSocket, next);
  assert.deepEqual(received.map(m => m.type), ["fresh"]);
});

test("main queues input after socket backpressure and preserves its order on drain", () => {
  const { context } = harness();
  const channel = socket();
  context.attachHostSocket(channel);
  channel.ready = false;
  context.sendHostMessage({ type: "first" });
  context.sendHostMessage({ type: "second" });
  context.sendHostMessage({ type: "third" });
  assert.deepEqual(channel.writes.map(m => m.type), ["first"]);
  channel.ready = true;
  channel.emit("drain");
  assert.deepEqual(channel.writes.map(m => m.type), ["first", "second", "third"]);
  assert.equal(context.hostMessageQueue.length, 0);
});
