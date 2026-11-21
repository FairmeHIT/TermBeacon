const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assignRecoverableSessions,
  normalizeDirectory,
  readRecentOpenCodeSessions,
} = require("../src/main/opencode-sessions.cjs");

const NOW = 1_800_000_000_000;
let sqliteAvailable = true;
try { require("node:sqlite"); } catch { sqliteAvailable = false; }

function terminal(overrides = {}) {
  return {
    id: "t1",
    cwd: "D:\\work\\app",
    agentType: "opencode",
    state: "ready",
    alive: false,
    lastActivityAt: NOW - 60_000,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: "ses_test000000000000000000000",
    directory: "D:/work/app",
    timeCreated: NOW - 120_000,
    timeUpdated: NOW - 60_000,
    source: "sqlite",
    ...overrides,
  };
}

test("normalizes Windows and POSIX directories for comparison", () => {
  assert.equal(normalizeDirectory("D:\\Work\\App\\", "win32"), "d:/work/app");
  assert.equal(normalizeDirectory("D:/Work/App", "win32"), "d:/work/app");
  assert.equal(normalizeDirectory("/home/me/App/", "linux"), "/home/me/App");
  assert.equal(normalizeDirectory("", "win32"), "");
});

test("recovers the only unmatched terminal in a folder from its recent session", () => {
  const assignments = assignRecoverableSessions([terminal()], [session()], { now: NOW, platform: "win32" });
  assert.deepEqual(assignments.map((entry) => [entry.terminalId, entry.sessionId]), [["t1", "ses_test000000000000000000000"]]);
});

test("never guesses when two terminals share one folder", () => {
  const terminals = [terminal({ id: "t1" }), terminal({ id: "t2" })];
  assert.deepEqual(assignRecoverableSessions(terminals, [session()], { now: NOW, platform: "win32" }), []);
});

test("skips sessions already owned by another terminal", () => {
  const terminals = [
    terminal({ id: "t1", lastSessionId: "ses_test000000000000000000000", lastSessionAgent: "opencode" }),
    terminal({ id: "t2" }),
  ];
  assert.deepEqual(assignRecoverableSessions(terminals, [session()], { now: NOW, platform: "win32" }), []);
});

test("rejects a session whose timestamp is far from the terminal's last activity", () => {
  const stale = session({ timeUpdated: NOW - 3 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(assignRecoverableSessions([terminal()], [stale], { now: NOW, platform: "win32" }), []);
});

test("only fills unmatched OpenCode terminals", () => {
  const claimed = terminal({ id: "t1", lastSessionId: "ses_owned00000000000000000000", lastSessionAgent: "opencode" });
  const generic = terminal({ id: "t2", agentType: "generic" });
  assert.deepEqual(assignRecoverableSessions([claimed, generic], [session()], { now: NOW, platform: "win32" }), []);
});

test("reads and merges current and legacy SQLite session tables", { skip: !sqliteAvailable }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-sessions-"));
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    db.exec(`
      create table session (id text, directory text, parent_id text, time_created integer, time_updated integer, title text);
      create table session_v2 (id text, directory text, parent_id text, time_created integer, time_updated integer, title text);
    `);
    const insert = (table, id, directory, parent, updated, title) => db.prepare(
      `insert into ${table} values (?, ?, ?, ?, ?, ?)`,
    ).run(id, directory, parent, updated - 1000, updated, title);
    insert("session", "ses_legacy0000000000000000000", "D:/work/app", null, NOW - 5000, "legacy");
    insert("session_v2", "ses_current000000000000000000", "D:/work/app", null, NOW - 1000, "current");
    insert("session_v2", "ses_child00000000000000000000", "D:/work/app", "ses_current000000000000000000", NOW, "child");
    db.close();

    const result = readRecentOpenCodeSessions({ dataDir: dir, now: NOW });
    assert.equal(result.source, "sqlite");
    assert.equal(result.error, null);
    assert.deepEqual(result.sessions.map((entry) => entry.id), [
      "ses_current000000000000000000",
      "ses_legacy0000000000000000000",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to legacy JSON session files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-sessions-json-"));
  const realNow = Date.now();
  try {
    const sessions = path.join(dir, "storage", "session", "project");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "ses_json0000000000000000000000.json"), JSON.stringify({
      id: "ses_json0000000000000000000000",
      directory: "D:/work/app",
      title: "from json",
      time: { created: realNow - 2000, updated: realNow - 1000 },
    }));
    fs.writeFileSync(path.join(sessions, "ses_child000000000000000000000.json"), JSON.stringify({
      id: "ses_child000000000000000000000",
      directory: "D:/work/app",
      parentID: "ses_json0000000000000000000000",
      time: { updated: realNow },
    }));
    const result = readRecentOpenCodeSessions({ dataDir: dir, now: realNow });
    assert.equal(result.source, "json");
    assert.deepEqual(result.sessions.map((entry) => entry.id), ["ses_json0000000000000000000000"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
