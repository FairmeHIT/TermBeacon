const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, toFixture, writeFixture } = require("../scripts/cli-capture-to-fixture.cjs");

test("converts a reviewed capture and redacts metadata and input", () => {
  const records = [
    { kind: "meta", schemaVersion: 1, agent: "claude", version: "2.1.318", command: "claude --danger", executable: "C:\\secret\\claude.cmd", startedAt: "secret" },
    { kind: "input", at: 100, data: "private prompt\r", source: "task" },
    { kind: "output", at: 200, data: "\u001b]0;◐ Claude Code\u0007" },
    { kind: "hook", at: 300, event: "Stop", status: "completed" },
    { kind: "exit", at: 400, exitCode: 0 },
  ];
  const fixture = toFixture(records, { sanitized: true, expected: "completed-unseen" });
  assert.deepEqual(fixture[0], {
    kind: "meta",
    agent: "claude",
    version: "2.1.318",
    name: "sanitized-capture",
    description: "Sanitized real CLI capture",
  });
  assert.deepEqual(fixture[1], { kind: "input", data: "[task]\r", at: 100 });
  assert.deepEqual(fixture.at(-1), { kind: "assert", state: "completed-unseen" });
  assert.equal(fixture.some((record) => record.kind === "exit"), false);
});

test("requires explicit sanitization and a valid expected state", () => {
  const records = [{ kind: "meta", agent: "generic" }];
  assert.throws(() => toFixture(records, { expected: "ready" }), /unreviewed capture/);
  assert.throws(() => toFixture(records, { sanitized: true, expected: "done" }), /expected state/);
  assert.deepEqual(parseArgs(["--sanitized", "--input", "a", "--output", "b", "--expected", "ready"]), {
    sanitized: true,
    keepInput: false,
    input: "a",
    output: "b",
    agent: undefined,
    name: undefined,
    description: undefined,
    version: undefined,
    expected: "ready",
  });
});

test("writes a fixture without retaining raw capture-only fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-fixture-"));
  try {
    const input = path.join(root, "capture.jsonl");
    const output = path.join(root, "fixture.jsonl");
    fs.writeFileSync(input, `${JSON.stringify({ kind: "meta", agent: "generic", command: "secret" })}\n${JSON.stringify({ kind: "input", data: "secret\r", at: 1 })}\n${JSON.stringify({ kind: "output", data: "> done", at: 2 })}\n`, "utf8");
    const result = writeFixture(input, output, { sanitized: true, expected: "completed-unseen" });
    assert.equal(result.agent, "generic");
    const text = fs.readFileSync(output, "utf8");
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes('"assert"'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite the source capture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-fixture-same-"));
  try {
    const input = path.join(root, "capture.jsonl");
    fs.writeFileSync(input, `${JSON.stringify({ kind: "meta", agent: "generic" })}\n`, "utf8");
    assert.throws(() => writeFixture(input, input, { sanitized: true, expected: "ready" }), /different files/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
