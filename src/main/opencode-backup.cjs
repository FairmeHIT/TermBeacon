const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { openCodeDatabasePath } = require("./opencode-paths.cjs");

const DEFAULT_RETENTION = 3;
const MIN_FREE_BYTES = 256 * 1024 * 1024;
// Compressed snapshots make the common case small, but a large OpenCode
// database must still not fill the disk. Keep the newest snapshot no matter
// what; prune older ones until the total is below this budget.
const MAX_TOTAL_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const BACKUP_PATTERN = /^opencode-.*\.db(?:\.gz)?$/;

function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function backupStamp(date) {
  const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("");
  const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
  return `${day}-${time}-${pad(date.getMilliseconds(), 3)}`;
}

function safeReason(value) {
  return typeof value === "string" && /^[a-z0-9-]{1,24}$/i.test(value) ? value : "manual";
}

async function listBackups(directory) {
  let names;
  try {
    names = await fsp.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const name of names) {
    if (!BACKUP_PATTERN.test(name)) continue;
    try {
      const stat = await fsp.stat(path.join(directory, name));
      if (stat.isFile()) files.push({ name, path: path.join(directory, name), bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* file disappeared during the scan */ }
  }
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

async function removeBackupSidecars(base) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { await fsp.unlink(`${base}${suffix}`); } catch { /* already gone */ }
  }
}

async function removeBackupPartials(base) {
  try { await fsp.unlink(base); } catch { /* already gone */ }
  await removeBackupSidecars(base);
}

async function pruneBackups(directory, retention, now, maxTotalBytes = MAX_TOTAL_BACKUP_BYTES) {
  const files = await listBackups(directory);
  const keep = Math.max(1, Math.floor(retention));
  const removed = [];
  // Count limit first: older snapshots beyond `retention` are always dropped.
  const retained = files.slice(0, keep);
  for (const file of files.slice(keep)) {
    try { await fsp.unlink(file.path); removed.push(file.name); } catch { /* best effort */ }
  }
  // Then enforce a total-size budget, deleting the oldest retained snapshots
  // while always keeping the newest one.
  let total = retained.reduce((sum, file) => sum + file.bytes, 0);
  for (let index = retained.length - 1; index >= 1 && total > maxTotalBytes; index -= 1) {
    const file = retained[index];
    try {
      await fsp.unlink(file.path);
      total -= file.bytes;
      removed.push(file.name);
    } catch { /* best effort */ }
  }
  // A crashed backup leaves hidden partial files and SQLite sidecars behind;
  // clean stale ones once they are old enough not to belong to a live run.
  try {
    const names = await fsp.readdir(directory);
    for (const name of names) {
      if (!name.startsWith(".partial-") || !/(\.db)(-wal|-shm|-journal)?(\.gz)?$/.test(name)) continue;
      const target = path.join(directory, name);
      try {
        const stat = await fsp.stat(target);
        if (now - stat.mtimeMs > 60 * 60 * 1000) await fsp.unlink(target);
      } catch { /* best effort */ }
    }
  } catch { /* directory may not exist yet */ }
  return removed;
}

function createOpenCodeBackup({
  dataDir,
  backupDir,
  retention = DEFAULT_RETENTION,
  now = Date.now,
  fsPromises = fsp,
} = {}) {
  if (!dataDir || !backupDir) throw new Error("OpenCode backup requires data and backup directories");
  let inFlight = null;

  async function run({ reason = "manual", minIntervalMs = 0, onlyIfChanged = false } = {}) {
    const started = now();
    const dbPath = openCodeDatabasePath(dataDir);
    let dbStat;
    try {
      dbStat = await fsPromises.stat(dbPath);
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, skipped: true, reason: "missing-db", file: dbPath };
      return { ok: false, error: `无法读取 OpenCode 数据库：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!Number.isFinite(dbStat.size) || dbStat.size <= 0) {
      return { ok: true, skipped: true, reason: "empty-db", file: dbPath };
    }

    await fsPromises.mkdir(backupDir, { recursive: true });
    // Enforce the size budget even when this run turns out to be a no-op, so
    // uncompressed snapshots from older versions cannot keep the disk full.
    try { await pruneBackups(backupDir, retention, started, MAX_TOTAL_BACKUP_BYTES); }
    catch (error) { console.warn("[opencode-backup] retention cleanup failed", error?.message || error); }
    const existing = await listBackups(backupDir);
    const latest = existing[0];
    if (latest) {
      const age = started - latest.mtimeMs;
      if (age >= 0 && age < minIntervalMs) {
        return { ok: true, skipped: true, reason: "fresh", file: latest.path, bytes: latest.bytes, ageMs: age };
      }
      if (onlyIfChanged) {
        let walMtime = 0;
        try { walMtime = (await fsPromises.stat(`${dbPath}-wal`)).mtimeMs; } catch { /* no WAL */ }
        if (Math.max(dbStat.mtimeMs, walMtime) <= latest.mtimeMs + 1000) {
          return { ok: true, skipped: true, reason: "unchanged", file: latest.path, bytes: latest.bytes };
        }
      }
    }

    let walBytes = 0;
    try { walBytes = (await fsPromises.stat(`${dbPath}-wal`)).size; } catch { /* no WAL */ }
    try {
      const stats = await fsPromises.statfs(backupDir);
      const free = Number(stats.bavail) * Number(stats.bsize);
      // Peak usage is the temporary copy plus its compressed output, followed
      // by deleting the raw copy. Leave a real safety margin instead of filling
      // the last few megabytes of the volume.
      const required = dbStat.size + Math.ceil(dbStat.size * 0.6) + walBytes + MIN_FREE_BYTES;
      if (Number.isFinite(free) && free < required) {
        return { ok: false, error: `备份空间不足：至少需要 ${Math.ceil(required / 1024 / 1024)} MB 可用空间` };
      }
    } catch { /* statfs is best-effort; the backup itself will report ENOSPC */ }

    const sqlite = loadSqlite();
    if (!sqlite?.DatabaseSync || typeof sqlite.backup !== "function") {
      return { ok: false, error: "当前运行环境不支持 SQLite 在线备份，已取消更新以保护会话数据" };
    }

    const temp = path.join(backupDir, `.partial-${process.pid}-${started}.db`);
    let source;
    try {
      source = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      source.exec("PRAGMA busy_timeout = 5000");
      await sqlite.backup(source, temp);
    } catch (error) {
      await removeBackupPartials(temp);
      return { ok: false, error: `OpenCode 会话备份失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      try { source?.close(); } catch { /* already closed */ }
    }

    const gzTemp = `${temp}.gz`;
    try {
      // Consolidate the WAL into the copied database and verify it before the
      // file is published. Leaving -wal/-shm sidecars next to a renamed backup
      // would make a later restore depend on files the retention pass does not
      // track.
      const check = new sqlite.DatabaseSync(temp);
      try {
        const rows = check.prepare("PRAGMA integrity_check").all();
        const healthy = rows.length > 0 && rows.every((row) => Object.values(row)[0] === "ok");
        if (!healthy) throw new Error("备份文件完整性检查未通过");
        try { check.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* not in WAL mode */ }
        try { check.exec("PRAGMA journal_mode = DELETE"); } catch { /* best effort */ }
      } finally {
        try { check.close(); } catch { /* already closed */ }
      }
      await removeBackupSidecars(temp);
      const rawBytes = (await fsPromises.stat(temp)).size;
      // OpenCode's session_message table is mostly text and compresses well.
      // Level 1 keeps the pre-update pause short while cutting disk use by
      // roughly two thirds on a typical database.
      await pipeline(
        fs.createReadStream(temp),
        zlib.createGzip({ level: 1 }),
        fs.createWriteStream(gzTemp),
      );
      const gzHandle = await fsPromises.open(gzTemp, "r+");
      try { await gzHandle.sync(); } finally { await gzHandle.close(); }
      const name = `opencode-${backupStamp(new Date(started))}-${safeReason(reason)}.db.gz`;
      const target = path.join(backupDir, name);
      await fsPromises.rename(gzTemp, target);
      await fsPromises.unlink(temp).catch(() => undefined);
      const bytes = (await fsPromises.stat(target)).size;
      let pruned = [];
      try {
        pruned = await pruneBackups(backupDir, retention, now(), MAX_TOTAL_BACKUP_BYTES);
      } catch (error) {
        console.warn("[opencode-backup] retention cleanup failed", error?.message || error);
      }
      return { ok: true, skipped: false, file: target, bytes, rawBytes, pruned };
    } catch (error) {
      await removeBackupPartials(temp);
      try { await fsPromises.unlink(gzTemp); } catch { /* no compressed partial */ }
      return { ok: false, error: `OpenCode 会话备份校验失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  function backupNow(options) {
    if (inFlight) return inFlight;
    inFlight = run(options).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function info() {
    const files = await listBackups(backupDir);
    return {
      directory: backupDir,
      count: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      latestAt: files[0]?.mtimeMs,
      latestFile: files[0]?.name,
      retention,
    };
  }

  async function clear() {
    if (inFlight) await inFlight.catch(() => undefined);
    const files = await listBackups(backupDir);
    for (const file of files) {
      try { await fsp.unlink(file.path); } catch { /* best effort */ }
    }
    try {
      for (const name of await fsp.readdir(backupDir)) {
        if (name.startsWith(".partial-")) {
          try { await fsp.unlink(path.join(backupDir, name)); } catch { /* best effort */ }
        }
      }
    } catch { /* directory may not exist */ }
    return info();
  }

  return { backupNow, listBackups: () => listBackups(backupDir), info, clear };
}

module.exports = { createOpenCodeBackup, backupStamp, DEFAULT_RETENTION, MAX_TOTAL_BACKUP_BYTES };
