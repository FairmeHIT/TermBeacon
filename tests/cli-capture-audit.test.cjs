const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCapture, summarizeCapture, parseArgs } = require("../scripts/cli-capture-audit.cjs");

test("audits capture structure without exposing terminal text", () => {
  const records = parseCapture([
    JSON.stringify({ kind: "meta", schemaVersion: 1, agent: "claude", version: "2.1.318", command: "claude" }),
    JSON.stringify({ kind: "output", at: 100, data: "secret prompt\u001b]0;◐ Claude Code\u0007" }),
    JSON.stringify({ kind: "input", at: 200, data: "do something\r", source: "task" }),
    JSON.stringify({ kind: "output", at: 500, data: "done" }),
    JSON.stringify({ kind: "exit", at: 600, exitCode: 0, signal: 0 }),
  ].join("\n"));
  const summary = summarizeCapture(records, "capture.jsonl");
  assert.equal(summary.agent, "claude");
  assert.equal(summary.durationMs, 600);
  assert.equal(summary.outputChunks, 2);
  assert.equal(summary.inputRecords, 1);
  assert.equal(summary.taskInputs, 1);
  assert.equal(summary.titleSignals, 1);
  assert.equal(summary.naturalExit, true);
  assert.equal(summary.taskEvidence, true);
  assert.equal(summary.fixtureEligible, true);
  assert.deepEqual(summary.reviewReasons, []);
  assert.equal(Object.hasOwn(summary, "prompt"), false);
  assert.equal(Object.hasOwn(summary, "output"), false);
});

test("marks timed-out captures for review without treating them as fixtures", () => {
  const records = parseCapture([
    JSON.stringify({ kind: "meta", schemaVersion: 1, agent: "opencode", command: "opencode" }),
    JSON.stringify({ kind: "input", at: 100, data: "task\r", source: "task" }),
    JSON.stringify({ kind: "output", at: 500, data: "busy" }),
  ].join("\n"));
  const summary = summarizeCapture(records);
  assert.equal(summary.fixtureEligible, false);
  assert.deepEqual(summary.reviewReasons, ["missing-exit"]);
});

test("rejects malformed capture lines and parses flags", () => {
  assert.throws(() => parseCapture('{"kind":"meta"}\nnot-json'), /line 2/);
  assert.deepEqual(parseArgs(["--json", "a.jsonl", "b.jsonl"]), { json: true, files: ["a.jsonl", "b.jsonl"] });
});
