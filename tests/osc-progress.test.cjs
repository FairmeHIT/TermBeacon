const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOscProgress } = require("../src/main/detection-engine.cjs");

test("parses OSC 9;4 progress sequences", () => {
  assert.deepEqual(parseOscProgress("before\u001b]9;4;1;42\u0007after"), { state: 1, progress: 42 });
  assert.deepEqual(parseOscProgress("\u001b]9;4;2;100\u001b\\"), { state: 2, progress: 100 });
  assert.equal(parseOscProgress("plain output"), undefined);
});
