// Discover Codex rollout files so a terminal can recover its own session id
// even when the CLI hook bridge is unavailable. Codex writes one JSONL file per
// interactive session under $CODEX_HOME/sessions/YYYY/MM/DD; the first line is
// a session_meta record that carries the thread id, working directory and
// process start time. Those three fields are enough to bind a session to the
// terminal that launched it, which is what `codex resume <id>` needs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// session_meta embeds the entire base instruction prompt, so the first line can
// be large. Stop reading after this many bytes instead of buffering a whole
// multi-megabyte rollout.
const MAX_META_BYTES = 512 * 1024;
const DEFAULT_DAYS = 3;
const START_WINDOW_MS = 30 * 1000;
const RECENT_MARGIN_MS = 1500;
// Slack for comparing two clocks (file mtime vs. wall clock) and for a process
// that starts a hair before the write timestamp is taken.
const MATCH_TOLERANCE_MS = 2 * 1000;

function resolveCodexHome({ env = process.env, home = os.homedir() } = {}) {
  const configured = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.join(home, ".codex");
}

// Windows paths are case-insensitive and may mix separators; comparing raw
// strings would miss `D:\repo` vs `d:/repo`. Other platforms keep case.
function normalizeCwd(value, platform = process.platform) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let resolved;
  try { resolved = path.resolve(value.trim()); } catch { return undefined; }
  const trimmed = resolved.replace(/[\\/]+$/, "") || resolved;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dayDirectories(codexHome, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const count = Number.isInteger(days) && days > 0 ? days : DEFAULT_DAYS;
  const directories = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(now - offset * 24 * 60 * 60 * 1000);
    directories.push(path.join(codexHome, "sessions", String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())));
  }
  return directories;
}

function listSessionFiles(codexHome, options = {}) {
  const files = [];
  // Every match has a fresh mtime: a new rollout appears on the first turn, and
  // a resumed rollout is appended to on the next one. Ignoring older files keeps
  // a probe from stat-ing an entire day of history.
  const minMtimeMs = Number.isFinite(options.minMtimeMs) ? options.minMtimeMs : -Infinity;
  for (const directory of dayDirectories(codexHome, options)) {
    let names;
    try { names = fs.readdirSync(directory); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const file = path.join(directory, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs >= minMtimeMs) files.push({ path: file, mtimeMs: stat.mtimeMs });
      } catch { /* the file may rotate between readdir and stat */ }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

// session_meta embeds the whole base instruction prompt, but the metadata fields
// come first and the line usually ends within tens of KiB. Read in chunks so a
// scan does not allocate (or read) half a megabyte per rollout.
const META_CHUNK_BYTES = 16 * 1024;

function readFirstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    let total = 0;
    while (total < MAX_META_BYTES) {
      const chunk = Buffer.allocUnsafe(META_CHUNK_BYTES);
      const count = fs.readSync(fd, chunk, 0, META_CHUNK_BYTES, total);
      if (!count) break;
      const newline = chunk.subarray(0, count).indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (!total) return undefined;
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

// A session_meta line never changes once written, so the parsed head can be
// cached by path even while the rollout keeps growing.
function readSessionMeta(entry, cache, platform = process.platform) {
  if (cache?.has(entry.path)) return cache.get(entry.path);
  let meta;
  const line = readFirstLine(entry.path);
  if (line) {
    try {
      const record = JSON.parse(line);
      const payload = record?.type === "session_meta" ? record.payload : undefined;
      const id = typeof payload?.id === "string" ? payload.id : payload?.session_id;
      const startedAt = Date.parse(payload?.timestamp);
      const cwd = normalizeCwd(payload?.cwd, platform);
      const source = typeof payload?.source === "string" ? payload.source : undefined;
      const originator = typeof payload?.originator === "string" ? payload.originator : undefined;
      // Non-interactive runs (`codex exec`) also write rollouts, but they never
      // belong to an interactive terminal and would pollute cwd matching.
      const interactive = source !== "exec" && !/exec/i.test(originator || "");
      if (typeof id === "string" && id && Number.isFinite(startedAt) && cwd && interactive) {
        meta = { id, cwd, startedAt, source, originator, path: entry.path };
      }
    } catch { /* a truncated or partial first line is simply skipped */ }
  }
  // Only completed session_meta heads are cached: an empty or half-written
  // first line must be retried once the rollout has been flushed.
  if (cache && meta) {
    if (cache.size > 1024) cache.clear();
    cache.set(entry.path, meta);
  }
  return meta;
}

function collectSessions({ codexHome, days, now, cache, minMtimeMs, platform = process.platform } = {}) {
  const home = codexHome || resolveCodexHome();
  const sessions = [];
  for (const entry of listSessionFiles(home, { days, now, minMtimeMs })) {
    const meta = readSessionMeta(entry, cache, platform);
    if (meta) sessions.push({ ...meta, mtimeMs: entry.mtimeMs });
  }
  return sessions;
}

// New sessions appear with a session_meta start time close to the moment the
// terminal wrote `codex`. A tight window keeps an idle terminal in the same
// workspace from adopting a sibling's brand-new session.
function findStartedSession(sessions, { cwd, launchedAt, excludeIds, windowMs = START_WINDOW_MS, toleranceMs = MATCH_TOLERANCE_MS, platform = process.platform } = {}) {
  const target = normalizeCwd(cwd, platform);
  if (!target || !Number.isFinite(launchedAt)) return undefined;
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  let best;
  for (const session of sessions) {
    if (!session || session.cwd !== target || excluded.has(session.id)) continue;
    // A rollout cannot start before the terminal wrote the command, so an older
    // file belongs to someone else (for example a sibling that just exited in
    // the same folder). The tolerance only absorbs ordering jitter.
    if (session.startedAt < launchedAt - toleranceMs || session.startedAt > launchedAt + windowMs) continue;
    const distance = Math.abs(session.startedAt - launchedAt);
    if (!best || distance < best.distance) best = { session, distance };
  }
  return best?.session;
}

// A resumed session keeps its original rollout file, so its meta start time is
// old. Codex appends to that file on the first new turn, which is the newest
// matching file after the resume command was written. Require a clear margin
// over the runner-up so two busy terminals in one folder cannot swap sessions.
function findRecentSession(sessions, { cwd, since, excludeIds, marginMs = RECENT_MARGIN_MS, platform = process.platform } = {}) {
  const target = normalizeCwd(cwd, platform);
  if (!target || !Number.isFinite(since)) return undefined;
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const candidates = sessions
    .filter((session) => session && session.cwd === target && !excluded.has(session.id)
      && Number.isFinite(session.mtimeMs) && session.mtimeMs >= since - MATCH_TOLERANCE_MS)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length || candidates[0].mtimeMs < since) return undefined;
  if (candidates.length > 1 && candidates[0].mtimeMs - candidates[1].mtimeMs < marginMs) return undefined;
  return candidates[0];
}

module.exports = {
  resolveCodexHome,
  normalizeCwd,
  dayDirectories,
  listSessionFiles,
  readSessionMeta,
  collectSessions,
  findStartedSession,
  findRecentSession,
};
