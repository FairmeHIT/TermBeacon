const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_TITLE_LENGTH, normalizeTitleInput } = require("../src/main/title-utils.cjs");

test("trims surrounding whitespace", () => {
  assert.equal(normalizeTitleInput("  终端 1  "), "终端 1");
  assert.equal(normalizeTitleInput("\tdev box\n"), "dev box");
});

test("returns empty for blank or non-string values", () => {
  assert.equal(normalizeTitleInput("   "), "");
  assert.equal(normalizeTitleInput(""), "");
  assert.equal(normalizeTitleInput(null), "");
  assert.equal(normalizeTitleInput(undefined), "");
  assert.equal(normalizeTitleInput(123), "");
});

test("truncates titles longer than the limit", () => {
  const long = "a".repeat(MAX_TITLE_LENGTH + 10);
  assert.equal(normalizeTitleInput(long), "a".repeat(MAX_TITLE_LENGTH));
  assert.equal(MAX_TITLE_LENGTH, 60);
});

test("keeps short titles unchanged and counts trimmed length first", () => {
  assert.equal(normalizeTitleInput("构建服务器"), "构建服务器");
  const padded = "b".repeat(MAX_TITLE_LENGTH - 2);
  assert.equal(normalizeTitleInput(`  ${padded}  `), padded);
  assert.equal(normalizeTitleInput("  " + "c".repeat(MAX_TITLE_LENGTH + 5)).length, MAX_TITLE_LENGTH);
});
