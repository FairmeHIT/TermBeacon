const fs = require("node:fs");
const path = require("node:path");
const { openCodeDatabasePath } = require("./opencode-paths.cjs");
const { sessionIdFitsAgent } = require("./session-resume.cjs");

// Only sessions touched within this window are considered for automatic
// recovery. The journal covers the normal path; this scan is a fallback for a
// lost state file and must not resurrect conversations from months ago.
const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
// A persisted terminal's last output and its OpenCode session should be close
// in time. The generous window absorbs clock changes and a session that kept
// running for a while after the terminal's last visible output.
const ACTIVITY_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_ROWS = 2000;
const MAX_TITLE_LENGTH = 200;

function normalizeDirectory(value, platform = process.platform) {
  if (typeof value !== "string") return "";
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  normalized = normalized.replace(/\/+$/, "");
  if (!normalized) return "";
  if (/^[a-zA-Z]:/.test(normalized)) normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function toEpochMs(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  // OpenCode stores milliseconds. Accept seconds too so a schema/version
  // change cannot make every session look ancient.
  return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
}

function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
}

function cleanTitle(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned ? cleaned.slice(0, MAX_TITLE_LENGTH) : undefined;
}

function sessionFromRow(row, source) {
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  if (!id || !sessionIdFitsAgent("opencode", id)) return null;
  if (row.parent_id) return null;
  const directory = typeof row.directory === "string" ? row.directory.trim() : "";
  if (!directory) return null;
  const timeUpdated = toEpochMs(row.time_updated ?? row.timeUpdated);
  const timeCreated = toEpochMs(row.time_created ?? row.timeCreated);
  return {
    id,
    directory,
    timeCreated: timeCreated || timeUpdated,
    timeUpdated: timeUpdated || timeCreated,
    ...(cleanTitle(row.title) ? { title: cleanTitle(row.title) } : {}),
    source,
  };
}

function readSqliteSessions(dbPath, { now, lookbackMs }) {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error("当前运行环境不支持 SQLite 会话读取");
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
    const byId = new Map();
    // OpenCode 2 keeps current sessions in session_v2 and older rows in
    // session. Merge both so an upgraded database still recovers old work.
    for (const table of ["session_v2", "session"]) {
      if (!tables.has(table)) continue;
      const rows = db.prepare(`select id, directory, parent_id, time_created, time_updated, title from "${table}" order by time_updated desc limit ${MAX_SESSION_ROWS}`).all();
      for (const row of rows) {
        const session = sessionFromRow(row, table);
        if (!session) continue;
        const previous = byId.get(session.id);
        if (!previous || session.timeUpdated > previous.timeUpdated) byId.set(session.id, session);
      }
    }
    const cutoff = now - lookbackMs;
    return [...byId.values()].filter((session) => session.timeUpdated >= cutoff).sort((a, b) => b.timeUpdated - a.timeUpdated);
  } finally {
    db.close();
  }
}

function listJsonFiles(directory, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(target, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
  }
  return files;
}

// Older OpenCode releases stored one JSON document per session under
// <data>/storage/session. Keep a best-effort reader so recovery still works
// after a downgrade or on a machine that has not migrated yet.
function readJsonSessions(dataDir, { now, lookbackMs }) {
  const root = path.join(dataDir, "storage", "session");
  if (!fs.existsSync(root)) return [];
  const cutoff = now - lookbackMs;
  const files = [];
  for (const file of listJsonFiles(root)) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs >= cutoff) files.push({ file, mtimeMs: stat.mtimeMs });
    } catch { /* file disappeared during the scan */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions = [];
  for (const entry of files.slice(0, MAX_SESSION_ROWS)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(entry.file, "utf8"));
      const time = parsed?.time || {};
      const session = sessionFromRow({
        id: parsed?.id,
        directory: parsed?.directory,
        parent_id: parsed?.parentID ?? parsed?.parentId ?? parsed?.parent_id,
        time_created: time.created ?? parsed?.timeCreated,
        time_updated: time.updated ?? parsed?.timeUpdated,
        title: parsed?.title,
      }, "json");
      if (session && session.timeUpdated >= cutoff) sessions.push(session);
    } catch { /* ignore malformed or half-written session files */ }
  }
  return sessions.sort((a, b) => b.timeUpdated - a.timeUpdated);
}

// Read-only recovery scan. A missing database is normal (OpenCode has not run
// yet); any failure is returned instead of thrown so startup is never blocked.
function readRecentOpenCodeSessions({ dataDir, now = Date.now(), lookbackMs = DEFAULT_LOOKBACK_MS } = {}) {
  if (!dataDir) return { sessions: [], source: "none", error: null };
  const dbPath = openCodeDatabasePath(dataDir);
  if (fs.existsSync(dbPath)) {
    try {
      return { sessions: readSqliteSessions(dbPath, { now, lookbackMs }), source: "sqlite", error: null };
    } catch (error) {
      return { sessions: readJsonSessions(dataDir, { now, lookbackMs }), source: "json", error: error instanceof Error ? error.message : String(error) };
    }
  }
  const sessions = readJsonSessions(dataDir, { now, lookbackMs });
  return { sessions, source: sessions.length ? "json" : "none", error: null };
}

function hasOwnedOpenCodeSession(terminal) {
  return terminal?.agentType === "opencode"
    && terminal.lastSessionAgent === "opencode"
    && sessionIdFitsAgent("opencode", terminal.lastSessionId);
}

// One OpenCode session id is one conversation. Two terminals that both claim
// it are the persisted residue of the old shared-server bug, where one tab's
// OSC 7501 status was written into every PTY. The session store knows the
// conversation's folder, so when exactly one claimant lives there it keeps the
// id and the others are cleared. A conflict without a single folder match is
// reported as unresolved: startup auto-resume must not guess which terminal
// owns it.
function resolveDuplicateSessionOwners(terminals, sessions, { platform = process.platform } = {}) {
  const groups = new Map();
  for (const terminal of Array.isArray(terminals) ? terminals : []) {
    if (!hasOwnedOpenCodeSession(terminal)) continue;
    const group = groups.get(terminal.lastSessionId) || [];
    group.push(terminal);
    groups.set(terminal.lastSessionId, group);
  }
  const directories = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session?.id) directories.set(session.id, normalizeDirectory(session.directory, platform));
  }
  const cleared = [];
  const unresolved = [];
  for (const [sessionId, group] of groups) {
    if (group.length < 2) continue;
    const directory = directories.get(sessionId);
    const matching = directory
      ? group.filter((terminal) => normalizeDirectory(terminal.cwd, platform) === directory)
      : [];
    if (matching.length !== 1) {
      unresolved.push(sessionId);
      continue;
    }
    const owner = matching[0];
    for (const terminal of group) {
      if (terminal === owner) continue;
      cleared.push({ terminalId: terminal.id, sessionId, ownerTerminalId: owner.id });
    }
  }
  return { cleared, unresolved };
}

// Map one recovered OpenCode session to a terminal only when the cwd has a
// single unmatched OpenCode terminal and the timestamps are plausible. With two
// terminals in one folder the data cannot say which conversation belonged to
// which, and opening the wrong one is worse than leaving the user to pick.
function assignRecoverableSessions(terminals, sessions, {
  now = Date.now(),
  platform = process.platform,
  toleranceMs = ACTIVITY_TOLERANCE_MS,
} = {}) {
  const list = Array.isArray(terminals) ? terminals : [];
  const candidates = Array.isArray(sessions) ? sessions : [];
  const claimed = new Set();
  for (const terminal of list) {
    // Claim every OpenCode-shaped id, even on a terminal that later switched
    // CLIs, so recovery cannot steal a conversation that already belongs to
    // another terminal in the sidebar.
    if (terminal?.lastSessionId && sessionIdFitsAgent("opencode", terminal.lastSessionId)) {
      claimed.add(terminal.lastSessionId);
    }
  }

  const groups = new Map();
  for (const terminal of list) {
    if (terminal?.agentType !== "opencode" || !terminal.cwd || hasOwnedOpenCodeSession(terminal)) continue;
    const key = normalizeDirectory(terminal.cwd, platform);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(terminal);
    groups.set(key, group);
  }

  const assignments = [];
  for (const [directory, group] of groups) {
    if (group.length !== 1) continue;
    const terminal = group[0];
    const activity = Number.isFinite(terminal.lastActivityAt) && terminal.lastActivityAt > 0 ? terminal.lastActivityAt : 0;
    const usable = candidates
      .filter((session) => session && !claimed.has(session.id) && normalizeDirectory(session.directory, platform) === directory)
      .filter((session) => !activity || Math.abs(session.timeUpdated - activity) <= toleranceMs)
      .sort((a, b) => b.timeUpdated - a.timeUpdated);
    const selected = usable[0];
    if (!selected) continue;
    claimed.add(selected.id);
    assignments.push({
      terminalId: terminal.id,
      sessionId: selected.id,
      agentType: "opencode",
      at: Math.min(now, selected.timeUpdated),
    });
  }
  return assignments;
}

module.exports = {
  ACTIVITY_TOLERANCE_MS,
  DEFAULT_LOOKBACK_MS,
  assignRecoverableSessions,
  normalizeDirectory,
  readRecentOpenCodeSessions,
  resolveDuplicateSessionOwners,
};
