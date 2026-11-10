const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildReport, readFixtureCoverage } = require("../scripts/cli-acceptance-report.cjs");

test("acceptance coverage reports fixture states and missing gates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-acceptance-"));
  fs.writeFileSync(path.join(root, "claude-working.jsonl"), `${JSON.stringify({ kind: "meta", agent: "claude", version: "x", evidence: "synthetic" })}\n${JSON.stringify({ kind: "assert", state: "working" })}\n`);
  fs.writeFileSync(path.join(root, "claude-error.jsonl"), `${JSON.stringify({ kind: "meta", agent: "claude" })}\n${JSON.stringify({ kind: "assert", state: "error" })}\n`);
  const fixtures = readFixtureCoverage(root);
  const report = buildReport({
    discovered: { claude: { installed: true, version: "x", integration: { state: "configured" } } },
    preflight: {
      cli: { claude: { readyForNativeCalibration: true } },
      hookClient: true,
      readyForOutputCalibration: true,
      readyForInteractiveCalibration: true,
    },
    fixtures,
    generatedAt: "2026-11-09T00:00:00.000Z",
  });
  assert.equal(fixtures.total, 2);
  assert.equal(fixtures.byAgent.claude.realCount, 0);
  assert.deepEqual(fixtures.byAgent.claude.evidence, { synthetic: 1, unspecified: 1 });
  assert.deepEqual(fixtures.byAgent.claude.states, { error: 1, working: 1 });
  assert.deepEqual(fixtures.byAgent.claude.scenarios, {});
  assert.deepEqual(fixtures.byAgent.claude.missingStates, ["completed-unseen", "awaiting-input"]);
  assert.ok(report.blockers.includes("claude: missing fixture state completed-unseen"));
  assert.ok(report.blockers.includes("claude: missing real reconnect evidence"));
  assert.equal(report.generatedAt, "2026-11-09T00:00:00.000Z");
});

test("reconnect evidence requires detached and attached markers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-acceptance-reconnect-"));
  const write = (name, records) => fs.writeFileSync(path.join(root, name), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const base = { kind: "meta", agent: "claude", version: "x", evidence: "real", scenario: "reconnect" };
  write("reconnect-incomplete.jsonl", [base, { kind: "reconnect", phase: "attached" }, { kind: "assert", state: "working" }]);
  let fixtures = readFixtureCoverage(root);
  let report = buildReport({
    discovered: { claude: { installed: true, version: "x", integration: { state: "configured" } } },
    preflight: { cli: { claude: { readyForNativeCalibration: true } }, hookClient: true, readyForOutputCalibration: true, readyForInteractiveCalibration: true },
    fixtures,
  });
  assert.ok(report.blockers.includes("claude: missing real reconnect evidence"));

  write("reconnect-complete.jsonl", [
    base,
    { kind: "reconnect", phase: "detached", source: "window" },
    { kind: "reconnect", phase: "attached", source: "window" },
    { kind: "assert", state: "working" },
  ]);
  fixtures = readFixtureCoverage(root);
  report = buildReport({
    discovered: { claude: { installed: true, version: "x", integration: { state: "configured" } } },
    preflight: { cli: { claude: { readyForNativeCalibration: true } }, hookClient: true, readyForOutputCalibration: true, readyForInteractiveCalibration: true },
    fixtures,
  });
  assert.equal(report.blockers.includes("claude: missing real reconnect evidence"), false);
});
