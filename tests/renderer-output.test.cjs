const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Execute the actual output subscriber with a deferred xterm writer. This
// catches ACK timing and rendering regressions without mocking its algorithm.
const source = fs.readFileSync(path.join(__dirname, "../src/renderer/App.tsx"), "utf8");
const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "window.termbeacon.onOutput") callback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(tree);
const compiled = ts.transpileModule(`globalThis.handleOutput = ${callback.getText(tree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const screenSource = fs.readFileSync(path.join(__dirname, "../src/renderer/terminal-screen.ts"), "utf8");
const screenModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(screenSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: screenModule.exports });

function harness() {
  const acknowledgements = [], receipts = [], writes = [], timers = [];
  const ref = () => ({ current: new Map() });
  const context = vm.createContext({
    terminalViews: ref(), consumedLocal: ref(), outputStreams: ref(), activityAt: ref(), agentTypeByTerminal: ref(),
    alternateScreenByTerminal: ref(), pendingHistory: ref(), historyFlushTimer: { current: null },
    splitScreenOutput: screenModule.exports.splitScreenOutput,
    normalizePiCursorOutput: screenModule.exports.normalizePiCursorOutput,
    window: {
      termbeacon: { acknowledgeOutput: (event, consumed = true) => { receipts.push(event); acknowledgements.push({ sequence: event.sequence, consumed }); } },
      setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    },
    flushPendingHistory() {},
  });
  context.terminalViews.current.set("t1", { write: (data, done) => writes.push({ data, done }) });
  vm.runInContext(compiled, context);
  const emit = (sequence, data = "line\r\n", overrides = {}) => context.handleOutput({ terminalId: "t1", sequence, data, streamId: "stream1", replay: false, at: sequence, ...overrides });
  return { context, emit, acknowledgements, receipts, writes, timers };
}

test("renderer ACKs parsing only after xterm finishes and schedules no output-triggered React updates", () => {
  const { emit, writes, acknowledgements, receipts, timers } = harness();
  emit(1);
  assert.equal(acknowledgements.length, 0);
  writes[0].done();
  assert.deepEqual(acknowledgements, [{ sequence: 1, consumed: true }]);
  assert.equal(Object.hasOwn(receipts[0], "data"), false, "ACK must not copy the output payload back across contextBridge");
  assert.deepEqual(timers.map((timer) => timer.delay), [750]);
});

test("duplicate replay releases flow credit without reparsing or claiming consumption", () => {
  const { emit, writes, acknowledgements } = harness();
  emit(1);
  emit(1, "line\r\n", { replay: true });
  assert.equal(writes.length, 1);
  assert.deepEqual(acknowledgements, [{ sequence: 1, consumed: false }]);
});

test("new PTY incarnations reset local sequence deduplication", () => {
  const { emit, writes } = harness();
  emit(100);
  emit(1, "new shell", { streamId: "stream2" });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].data, "new shell");
});

test("Pi hardware cursor stays hidden inside the alternate screen", () => {
  const { context, emit, writes } = harness();
  context.agentTypeByTerminal.current.set("t1", "pi");
  emit(1, "\x1b[?1049h\x1b[?25l\x1b[29;1Hinput\x1b[?25h");
  assert.equal(writes.length, 1);
  assert.match(writes[0].data, /\x1b\[\?1049h/);
  assert.doesNotMatch(writes[0].data, /\x1b\[\?25h/);
  assert.equal(context.alternateScreenByTerminal.current.get("t1"), true);
});

test("Pi restores the normal-screen cursor after leaving the alternate screen", () => {
  const { context, emit, writes } = harness();
  context.agentTypeByTerminal.current.set("t1", "pi");
  context.alternateScreenByTerminal.current.set("t1", true);
  emit(1, "\x1b[?1049l\x1b[?25h");
  assert.equal(writes[0].data, "\x1b[?1049l\x1b[?25h");
  assert.equal(context.alternateScreenByTerminal.current.get("t1"), false);
});

test("pending history stays bounded when flush timers are throttled", () => {
  const { context, emit } = harness();
  for (let i = 1; i < 400; i += 1) emit(i, "中🙂".repeat(1000));
  const pending = context.pendingHistory.current.get("t1");
  const tail = pending.chunks.slice(pending.start).join("");
  assert.ok(tail.length <= 250000);
  assert.equal(tail.length, pending.length);
  assert.ok(!/^[\uDC00-\uDFFF]/.test(tail));
});
