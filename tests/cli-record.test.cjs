const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, isMeaningfulInput } = require("../scripts/cli-record.cjs");

test("cli recorder parses hook-log as a boolean flag", () => {
  const args = parseArgs(["--cli", "claude", "--hook-log", "--max-minutes", "2", "--task", "status"]);
  assert.equal(args.cli, "claude");
  assert.equal(args.hookLog, true);
  assert.equal(args.maxMinutes, 2);
  assert.equal(args.task, "status");
});

test("cli recorder only records meaningful input", () => {
  assert.equal(isMeaningfulInput("\u001b[<0;1;1M"), false);
  assert.equal(isMeaningfulInput("status\r"), true);
  assert.equal(isMeaningfulInput("\u0003"), true);
});
