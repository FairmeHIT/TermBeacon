const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Execute the actual prompt-key helpers from App.tsx so keyboard regressions
// are caught without duplicating the logic in the test.
const source = fs.readFileSync(path.join(__dirname, "../src/renderer/App.tsx"), "utf8");
const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findFunction(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.getText(tree) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `missing function ${name} in App.tsx`);
  return ts.transpileModule(found.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

function findArrow(calleeName) {
  let found;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === calleeName) found = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `missing ${calleeName} callback in App.tsx`);
  return ts.transpileModule(`globalThis.handleKey = ${found.getText(tree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const actionModule = { exports: {} };
vm.runInNewContext(findFunction("promptKeyAction"), actionModule.exports);
const promptKeyAction = actionModule.exports.promptKeyAction;

const guardModule = { exports: {} };
vm.runInNewContext(findFunction("preserveImeGuardOnShift"), guardModule.exports);
const preserveImeGuardOnShift = guardModule.exports.preserveImeGuardOnShift;

const keyCallback = findArrow("term.attachCustomKeyEventHandler");
const writes = [];
const pasted = [];
function keyContext() {
  const context = vm.createContext({
    promptKeyAction,
    window: {
      termbeacon: {
        write: (request) => writes.push(request),
        readClipboardText: () => Promise.resolve("clipboard text"),
      },
    },
    term: { paste: (text) => pasted.push(text) },
    terminal: { id: "t1" },
  });
  vm.runInContext(keyCallback, context);
  return context;
}

const event = (overrides = {}) => ({ type: "keydown", key: "Enter", altKey: false, metaKey: false, shiftKey: false, ctrlKey: false, isComposing: false, keyCode: 13, preventDefault() {}, stopPropagation() {}, ...overrides });

test("Shift+Enter and Ctrl+Enter are treated as newline, plain Enter stays passthrough", () => {
  assert.equal(promptKeyAction(event()), "passthrough");
  assert.equal(promptKeyAction(event({ shiftKey: true })), "newline");
  assert.equal(promptKeyAction(event({ ctrlKey: true })), "newline");
  assert.equal(promptKeyAction(event({ ctrlKey: true, shiftKey: true })), "newline");
});

test("Alt+Enter and keyup are not remapped, clipboard shortcuts still paste", () => {
  assert.equal(promptKeyAction(event({ altKey: true })), "passthrough");
  assert.equal(promptKeyAction(event({ metaKey: true })), "passthrough");
  assert.equal(promptKeyAction(event({ type: "keyup", shiftKey: true })), "passthrough");
  assert.equal(promptKeyAction(event({ key: "v", ctrlKey: true })), "paste");
  assert.equal(promptKeyAction(event({ key: "Insert", shiftKey: true })), "paste");
  assert.equal(promptKeyAction(event({ shiftKey: true, isComposing: true })), "passthrough", "IME owns its keys");
  assert.equal(promptKeyAction(event({ shiftKey: true, keyCode: 229 })), "passthrough");
});

test("custom key handler sends LF for modified Enter and never submits via CR", () => {
  writes.length = 0;
  pasted.length = 0;
  const context = keyContext();
  assert.equal(context.handleKey(event({ shiftKey: true })), false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].terminalId, "t1");
  assert.equal(writes[0].data, "\n");
  assert.equal(context.handleKey(event()), true);
  assert.equal(writes.length, 1, "plain Enter must stay with xterm (CR submit)");
});

test("custom key handler keeps clipboard paste behaviour", async () => {
  writes.length = 0;
  pasted.length = 0;
  const context = keyContext();
  assert.equal(context.handleKey(event({ key: "v", ctrlKey: true })), false);
  await Promise.resolve();
  assert.deepEqual(pasted, ["clipboard text"]);
  assert.equal(writes.length, 0);
});

test("pure Shift keydown restores the IME guard so Sogou commit is delivered", () => {
  let guard = false;
  const originalCalls = [];
  const core = {
    _keyDownSeen: false,
    _keyDown: (e) => { originalCalls.push(e); guard = true; return "result"; },
  };
  preserveImeGuardOnShift({ _core: core });
  const shift = event({ key: "Shift" });
  assert.equal(core._keyDown(shift), "result");
  assert.equal(originalCalls.length, 1);
  assert.equal(core._keyDownSeen, false, "guard must be restored after a Shift keydown");
});

test("non-Shift keydown still sets the IME guard as xterm expects", () => {
  let guard = false;
  const core = {
    _keyDownSeen: false,
    _keyDown: () => { guard = true; },
  };
  preserveImeGuardOnShift({ _core: core });
  core._keyDown(event({ key: "a" }));
  assert.equal(guard, true);
});
