const test = require("node:test");
const assert = require("node:assert/strict");
const processPath = require("node:path").delimiter;
const { discoveryPath, firstOutputLine, version } = require("../src/main/cli-discovery.cjs");

test("discovery path preserves PATH entries and adds macOS tool locations", () => {
  const value = discoveryPath({ PATH: "/custom/bin" });
  assert.ok(value.split(processPath).includes("/custom/bin"));
  if (process.platform === "darwin") assert.ok(value.split(processPath).includes("/opt/homebrew/bin"));
});

test("version reads the first line from a directly executable CLI", () => {
  const value = version("node", process.execPath);
  assert.match(value || "", /^v\d+/);
});

test("first output line is bounded and handles empty output", () => {
  assert.equal(firstOutputLine(""), undefined);
  assert.equal(firstOutputLine("first\nsecond"), "first");
  assert.equal(firstOutputLine("x".repeat(200)).length, 160);
});
