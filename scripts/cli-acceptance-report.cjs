#!/usr/bin/env node
/**
 * Build a read-only CLI acceptance report from local preflight data and
 * sanitized detector fixtures. It never installs integrations or runs a
 * model task.
 */
const fs = require("node:fs");
const path = require("node:path");
const { discoverAll } = require("../src/main/cli-discovery.cjs");
const { inspectPreflight } = require("./cli-preflight.cjs");

const DEFAULT_FIXTURE_DIR = path.join(__dirname, "..", "tests", "fixtures", "agents");
const REQUIRED_STATES = ["working", "completed-unseen", "awaiting-input", "error"];
const REQUIRED_REAL_SCENARIOS = ["error", "long-output", "permission", "retry", "reconnect"];
const NATIVE_AGENTS = ["claude", "opencode", "pi"];
const REQUIRED_REAL_FIXTURES = 10;

function reconnectEvidence(records) {
  const markers = records.filter((record) => record?.kind === "reconnect" && record.source === "window");
  const phases = new Set(markers.map((record) => record.phase));
  return {
    detached: phases.has("detached"),
    attached: phases.has("attached"),
    complete: phases.has("detached") && phases.has("attached"),
  };
}

function parseArgs(argv) {
  const args = { json: false, fixtures: DEFAULT_FIXTURE_DIR, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--fixtures") args.fixtures = path.resolve(argv[++index] || "");
    else if (token === "--out") args.out = path.resolve(argv[++index] || "");
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function readFixture(file) {
  const records = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    });
  const meta = records.find((record) => record?.kind === "meta");
  const assertion = records.find((record) => record?.kind === "assert");
  if (typeof meta?.agent !== "string" || typeof assertion?.state !== "string") {
    throw new Error(`${file}: fixture requires meta.agent and assert.state`);
  }
  return {
    file: path.basename(file),
    agent: meta.agent,
    name: typeof meta.name === "string" ? meta.name : path.basename(file, ".jsonl"),
    version: typeof meta.version === "string" ? meta.version : undefined,
    evidence: typeof meta.evidence === "string" ? meta.evidence : "unspecified",
    scenario: typeof meta.scenario === "string" ? meta.scenario : undefined,
    reconnect: reconnectEvidence(records),
    state: assertion.state,
  };
}

function readFixtureCoverage(directory = DEFAULT_FIXTURE_DIR) {
  if (!fs.existsSync(directory)) throw new Error(`fixture directory not found: ${directory}`);
  const files = fs.readdirSync(directory)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .map((file) => readFixture(path.join(directory, file)));
  const byAgent = {};
  for (const fixture of files) {
    const entry = byAgent[fixture.agent] ||= { count: 0, realCount: 0, evidence: {}, states: {}, scenarios: {}, realScenarios: {}, realScenarioStates: {}, realScenarioEvidence: {}, versions: [], fixtures: [] };
    entry.count += 1;
    entry.evidence[fixture.evidence] = (entry.evidence[fixture.evidence] || 0) + 1;
    if (fixture.evidence === "real") entry.realCount += 1;
    entry.states[fixture.state] = (entry.states[fixture.state] || 0) + 1;
    if (fixture.scenario) {
      entry.scenarios[fixture.scenario] = (entry.scenarios[fixture.scenario] || 0) + 1;
      if (fixture.evidence === "real") {
        entry.realScenarios[fixture.scenario] = (entry.realScenarios[fixture.scenario] || 0) + 1;
        const states = entry.realScenarioStates[fixture.scenario] ||= {};
        states[fixture.state] = (states[fixture.state] || 0) + 1;
        if (fixture.scenario === "reconnect" && fixture.reconnect.complete) {
          entry.realScenarioEvidence.reconnect = (entry.realScenarioEvidence.reconnect || 0) + 1;
        }
      }
    }
    if (fixture.version && !entry.versions.includes(fixture.version)) entry.versions.push(fixture.version);
    entry.fixtures.push({
      file: fixture.file,
      name: fixture.name,
      state: fixture.state,
      evidence: fixture.evidence,
      ...(fixture.scenario ? { scenario: fixture.scenario } : {}),
      ...(fixture.scenario === "reconnect" ? { reconnect: fixture.reconnect } : {}),
    });
  }
  for (const entry of Object.values(byAgent)) {
    entry.missingStates = REQUIRED_STATES.filter((state) => !entry.states[state]);
  }
  return { total: files.length, requiredStates: REQUIRED_STATES, byAgent };
}

function createPreflight(discovered) {
  return inspectPreflight({
    discovered,
    hookClient: fs.existsSync(path.join(__dirname, "termbeacon-hook.cjs")),
    opencodePlugin: discovered.opencode?.integration?.state === "configured",
    claudeSettings: discovered.claude?.integration?.state === "configured",
    piExtension: discovered.pi?.integration?.state === "configured",
  });
}

function buildReport({ discovered, preflight, fixtures, generatedAt = new Date().toISOString() }) {
  const blockers = [];
  for (const id of NATIVE_AGENTS) {
    const cli = preflight.cli[id];
    const installed = cli?.installed ?? discovered[id]?.installed;
    if (!installed) blockers.push(`${id}: CLI not installed`);
    else if (!cli?.readyForNativeCalibration) blockers.push(`${id}: native integration is not ready`);
    const realCount = fixtures.byAgent[id]?.realCount || 0;
    if (installed && realCount < REQUIRED_REAL_FIXTURES) blockers.push(`${id}: ${REQUIRED_REAL_FIXTURES - realCount} real task fixture(s) required`);
    const coverage = fixtures.byAgent[id];
    if (installed && coverage) {
      for (const scenario of REQUIRED_REAL_SCENARIOS) {
        const scenarioCount = coverage.realScenarios?.[scenario] || 0;
        const permissionWaiting = scenario === "permission"
          ? (coverage.realScenarioStates?.[scenario]?.["awaiting-input"] || 0) > 0
          : scenario === "reconnect"
            ? (coverage.realScenarioEvidence?.reconnect || 0) > 0
            : scenarioCount > 0;
        if (!permissionWaiting) blockers.push(`${id}: missing real ${scenario} evidence`);
      }
    }
  }
  for (const [agent, coverage] of Object.entries(fixtures.byAgent)) {
    for (const state of coverage.missingStates) blockers.push(`${agent}: missing fixture state ${state}`);
  }
  return {
    generatedAt,
    scope: "Windows x64",
    cli: Object.fromEntries(Object.entries(discovered).map(([id, item]) => [id, {
      installed: Boolean(item?.installed),
      version: item?.version,
      executable: item?.executable,
      integration: item?.integration,
      readyForNativeCalibration: Boolean(preflight.cli[id]?.readyForNativeCalibration),
    }])),
    preflight: {
      hookClient: preflight.hookClient,
      readyForOutputCalibration: preflight.readyForOutputCalibration,
      readyForInteractiveCalibration: preflight.readyForInteractiveCalibration,
    },
    fixtures: { ...fixtures, requiredRealScenarios: REQUIRED_REAL_SCENARIOS },
    blockers,
  };
}

function usage() {
  console.error(`Usage: node scripts/cli-acceptance-report.cjs [--json] [--fixtures <dir>] [--out <file>]`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return; }
  const discovered = await discoverAll();
  const preflight = createPreflight(discovered);
  const fixtures = readFixtureCoverage(args.fixtures);
  const report = buildReport({ discovered, preflight, fixtures });
  const output = args.json ? JSON.stringify(report) : [
    `TermBeacon CLI acceptance report (${report.scope})`,
    ...Object.entries(report.cli).map(([id, item]) => `- ${id}: ${item.installed ? `installed${item.version ? ` (${item.version})` : ""}` : "not found"}; native calibration ${item.readyForNativeCalibration ? "ready" : "blocked"}`),
    `- fixtures: ${fixtures.total}`,
    ...Object.entries(fixtures.byAgent).map(([agent, entry]) => `- ${agent}: ${entry.count} fixture(s), ${entry.realCount} real; states ${Object.keys(entry.states).sort().join(", ") || "none"}`),
    `- blockers: ${report.blockers.length ? report.blockers.join("; ") : "none"}`,
  ].join("\n");
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(output);
  if (report.blockers.length > 0) process.exitCode = 2;
}

if (require.main === module) main().catch((error) => {
  console.error(`[acceptance] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

module.exports = { REQUIRED_STATES, REQUIRED_REAL_SCENARIOS, NATIVE_AGENTS, REQUIRED_REAL_FIXTURES, parseArgs, reconnectEvidence, readFixture, readFixtureCoverage, buildReport };
