const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidCwd } = require("../src/main/cwd-utils.cjs");

test("accepts absolute Windows paths", () => {
  assert.equal(isValidCwd("C:\\Users\\dev", true), true);
  assert.equal(isValidCwd("d:/work/project", true), true);
  assert.equal(isValidCwd("\\\\server\\share", true), true);
});

test("accepts absolute Unix paths", () => {
  assert.equal(isValidCwd("/", false), true);
  assert.equal(isValidCwd("/home/dev/project", false), true);
});

test("rejects relative paths", () => {
  assert.equal(isValidCwd(".", true), false);
  assert.equal(isValidCwd("relative/path", true), false);
  assert.equal(isValidCwd("C:", true), false);
  assert.equal(isValidCwd("home/dev", false), false);
  assert.equal(isValidCwd("C:\\Users\\dev", false), false);
});

test("rejects empty or non-string values", () => {
  assert.equal(isValidCwd("", true), false);
  assert.equal(isValidCwd(null, true), false);
  assert.equal(isValidCwd(undefined, false), false);
  assert.equal(isValidCwd(123, true), false);
});
