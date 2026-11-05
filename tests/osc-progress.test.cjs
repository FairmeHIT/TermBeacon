const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOscProgress } = require("../src/main/detection-engine.cjs");

test("parses OSC 9;4 progress sequences", () => {
  assert.deepEqual(parseOscProgress("before\u001b]9;4;1;42\u0007after"), { state: 1, progress: 42 });
  assert.deepEqual(parseOscProgress("\u001b]9;4;2;100\u001b\\"), { state: 2, progress: 100 });
  assert.equal(parseOscProgress("plain output"), undefined);
});

test("parses OSC 9;4 sequences with an omitted progress value", () => {
  assert.equal(parseOscProgress("\u001b]9;4;0;\u0007").state, 0);
  assert.equal(parseOscProgress("\u001b]9;4;0;\u0007").progress, undefined);
  assert.equal(parseOscProgress("\u001b]9;4;0\u0007").state, 0);
  assert.equal(parseOscProgress("\u001b]9;4;1;\u0007").progress, undefined);
});
