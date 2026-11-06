const test = require("node:test");
const assert = require("node:assert");
const { summarize, isMeaningful } = require("../src/main/summary-utils.cjs");

test("strips OSC title sequences entirely", () => {
  assert.strictEqual(summarize("\x1b]0;Claude Code\x07Analyzing repository"), "Analyzing repository");
});

test("strips CSI colour and cursor codes", () => {
  assert.strictEqual(summarize("\x1b[1;32mRunning tests\x1b[0m\x1b[2K"), "Running tests");
});

test("drops decoration-only lines such as spinners and box drawing", () => {
  // Claude Code style spinner line followed by real text.
  assert.strictEqual(summarize("✻ ╭─╮ │ ░▒▓█\nReading 12 files"), "Reading 12 files");
  assert.strictEqual(summarize("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"), undefined);
});

test("drops progress-bar noise", () => {
  // Block characters are removed; the percentage remains and is still shown.
  assert.strictEqual(summarize("[████████░░░░] 67%"), "[] 67%");
});

test("ignores control characters and zero-width marks", () => {
  assert.strictEqual(summarize("Sta\u0007rt\u200b \u009fedit"), "Start edit");
});

test("removes carriage-return progress spam and keeps the last real line", () => {
  assert.strictEqual(summarize("Downloading 10%\rDownloading 55%\rDownloading 100%"), "Downloading 100%");
});

test("keeps CJK activity text", () => {
  assert.strictEqual(summarize("正在读取 3 个文件"), "正在读取 3 个文件");
});

test("returns undefined for empty or purely decorative chunks", () => {
  assert.strictEqual(summarize(""), undefined);
  assert.strictEqual(summarize("\x1b[2J\x1b[H"), undefined);
  assert.strictEqual(summarize("\n\n  \n"), undefined);
});

test("caps the summary length", () => {
  const summary = summarize("x".repeat(300));
  assert.strictEqual(summary.length, 90);
});

test("isMeaningful requires two real characters", () => {
  assert.strictEqual(isMeaningful("ok"), true);
  assert.strictEqual(isMeaningful(">"), false);
  assert.strictEqual(isMeaningful("│ ─ │"), false);
});
