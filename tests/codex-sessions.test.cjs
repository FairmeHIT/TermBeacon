const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveCodexHome,
  dayDirectories,
  collectSessions,
  findStartedSession,
  findRecentSession,
} = require("../src/main/codex-sessions.cjs");

const NOW = Date.parse("2026-11-15T12:00:00Z");
const CWD = process.platform === "win32" ? "C:\\Work\\Repo" : "/work/repo";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-codex-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = dayDirectories(home, { days: 1, now: NOW })[0];
  fs.mkdirSync(directory, { recursive: true });
  return { home, directory };
}

function writeRollout(directory, { id, startedAt, cwd = CWD, mtimeMs = startedAt, source = "cli", originator = "codex-tui" }) {
  const file = path.join(directory, `rollout-2026-11-15T12-00-00-${id}.jsonl`);
  const meta = {
    timestamp: new Date(startedAt).toISOString(),
    type: "session_meta",
    payload: { id, session_id: id, timestamp: new Date(startedAt).toISOString(), cwd, source, originator },
  };
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`, "utf8");
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test("CODEX_HOME overrides the default home", () => {
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: "D:\\custom" }, home: "C:\\Users\\me" }), path.resolve("D:\\custom"));
  assert.equal(resolveCodexHome({ env: {}, home: path.join("C:", "Users", "me") }), path.join("C:", "Users", "me", ".codex"));
});

test("collectSessions reads the session_meta head and skips exec rollouts", (t) => {
  const { home, directory } = fixture(t);
  const now = NOW;
  writeRollout(directory, { id: "11111111-1111-4111-8111-111111111111", startedAt: now - 5000 });
  writeRollout(directory, { id: "22222222-2222-4222-8222-222222222222", startedAt: now - 4000, source: "exec", originator: "codex_exec" });
  const cache = new Map();
  const sessions = collectSessions({ codexHome: home, now, cache });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "11111111-1111-4111-8111-111111111111");
  assert.equal(sessions[0].startedAt, now - 5000);
  assert.equal(cache.size, 1);
  // A cached meta is reused without reopening the file.
  const again = collectSessions({ codexHome: home, now, cache });
  assert.equal(again[0].id, sessions[0].id);
});

test("collectSessions reads a session_meta line larger than one read chunk", (t) => {
  const { home, directory } = fixture(t);
  const file = writeRollout(directory, { id: "big", startedAt: NOW - 1000 });
  // Real sessions embed the base instruction prompt, which pushes the first
  // line past the 16 KiB chunk the reader uses.
  const line = fs.readFileSync(file, "utf8").split("\n")[0]
    .replace('"cwd"', `"base_instructions":"${"x".repeat(40000)}","cwd"`);
  fs.writeFileSync(file, `${line}\n`);
  const sessions = collectSessions({ codexHome: home, now: NOW });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "big");
  assert.equal(sessions[0].cwd, process.platform === "win32" ? CWD.toLowerCase() : CWD);
});

test("collectSessions skips rollouts older than the lookback", (t) => {
  const { home, directory } = fixture(t);
  writeRollout(directory, { id: "old", startedAt: NOW - 600_000, mtimeMs: NOW - 600_000 });
  writeRollout(directory, { id: "fresh", startedAt: NOW - 60_000, mtimeMs: NOW - 60_000 });
  const sessions = collectSessions({ codexHome: home, now: NOW, minMtimeMs: NOW - 300_000 });
  assert.deepEqual(sessions.map((session) => session.id), ["fresh"]);
});

test("findStartedSession matches the same folder inside a tight launch window", (t) => {
  const { home, directory } = fixture(t);
  writeRollout(directory, { id: "own", startedAt: NOW - 2000 });
  writeRollout(directory, { id: "older", startedAt: NOW - 240000 });
  writeRollout(directory, { id: "elsewhere", startedAt: NOW - 1500, cwd: process.platform === "win32" ? "C:\\Other" : "/other" });
  const sessions = collectSessions({ codexHome: home, now: NOW });
  const launchedAt = NOW - 1200;
  assert.equal(findStartedSession(sessions, { cwd: CWD, launchedAt }).id, "own");
  // An id already reported by another terminal is never reassigned.
  assert.equal(findStartedSession(sessions, { cwd: CWD, launchedAt, excludeIds: new Set(["own"]) }), undefined);
  // A sibling launched minutes later must not be adopted by this idle terminal.
  assert.equal(findStartedSession(sessions, { cwd: CWD, launchedAt: NOW - 60000 }), undefined);
});

test("findStartedSession compares Windows paths case-insensitively", (t) => {
  if (process.platform !== "win32") return;
  const { home, directory } = fixture(t);
  writeRollout(directory, { id: "own", startedAt: NOW - 1000 });
  const sessions = collectSessions({ codexHome: home, now: NOW });
  assert.equal(findStartedSession(sessions, { cwd: "c:/work/repo/", launchedAt: NOW - 900 }).id, "own");
});

test("findStartedSession ignores a rollout that started before the launch", (t) => {
  const { home, directory } = fixture(t);
  writeRollout(directory, { id: "sibling", startedAt: NOW - 10_000, mtimeMs: NOW - 10_000 });
  const sessions = collectSessions({ codexHome: home, now: NOW });
  // Within the +30s window but older than the launch: it belongs to a terminal
  // that ran here earlier, so adopting it would restore the wrong thread.
  assert.equal(findStartedSession(sessions, { cwd: CWD, launchedAt: NOW }), undefined);
  // The tolerance is a parameter, which is what a banner-anchored launch (where
  // the process started before the anchor) relies on.
  assert.equal(findStartedSession(sessions, { cwd: CWD, launchedAt: NOW, toleranceMs: 15_000 }).id, "sibling");
});

test("findRecentSession uses the rollout an older resume just appended to", (t) => {
  const { home, directory } = fixture(t);
  writeRollout(directory, { id: "resumed", startedAt: NOW - 3600_000, mtimeMs: NOW - 500 });
  writeRollout(directory, { id: "stale", startedAt: NOW - 7200_000, mtimeMs: NOW - 120_000 });
  const sessions = collectSessions({ codexHome: home, now: NOW });
  assert.equal(findRecentSession(sessions, { cwd: CWD, since: NOW - 2000 }).id, "resumed");
  // Before the resume command, the same file is not a candidate.
  assert.equal(findRecentSession(sessions, { cwd: CWD, since: NOW - 100 }), undefined);
  assert.equal(findRecentSession(sessions, { cwd: CWD, since: NOW - 2000, excludeIds: new Set(["resumed"]) }), undefined);
});

test("findRecentSession refuses to guess between two equally fresh rollouts", (t) => {
  const { home, directory } = fixture(t);
  writeRollout(directory, { id: "left", startedAt: NOW - 3600_000, mtimeMs: NOW - 400 });
  writeRollout(directory, { id: "right", startedAt: NOW - 3600_000, mtimeMs: NOW - 500 });
  const sessions = collectSessions({ codexHome: home, now: NOW });
  assert.equal(findRecentSession(sessions, { cwd: CWD, since: NOW - 2000 }), undefined);
});
