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

test("cli recorder parses a redacted command task label", () => {
  const args = parseArgs(["--cli", "claude", "--task-label", "TASK-01"]);
  assert.equal(args.taskLabel, "TASK-01");
});

test("cli recorder parses delayed interactive exit", () => {
  const args = parseArgs(["--cli", "pi", "--task", "status", "--task-delay", "1000", "--exit-after", "5000"]);
  assert.equal(args.taskDelay, 1000);
  assert.equal(args.exitAfter, 5000);
});

test("cli recorder only records meaningful input", () => {
  assert.equal(isMeaningfulInput("\u001b[<0;1;1M"), false);
  assert.equal(isMeaningfulInput("status\r"), true);
  assert.equal(isMeaningfulInput("\u0003"), true);
});
