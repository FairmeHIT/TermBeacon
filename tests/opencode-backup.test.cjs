const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { createOpenCodeBackup } = require("../src/main/opencode-backup.cjs");

let sqliteAvailable = true;
try { require("node:sqlite"); } catch { sqliteAvailable = false; }

function makeDatabase(dir) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec("create table session_v2 (id text, title text); pragma journal_mode=wal;");
  db.prepare("insert into session_v2 values (?, ?)").run("ses_a", "hello");
  return db;
}

test("missing OpenCode database is a successful no-op", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-backup-missing-"));
  try {
    const backup = createOpenCodeBackup({ dataDir: dir, backupDir: path.join(dir, "backups") });
    const result = await backup.backupNow({ reason: "update" });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "missing-db");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("online backup includes WAL rows and passes integrity_check", { skip: !sqliteAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-backup-"));
  const db = makeDatabase(dir);
  try {
    const backupDir = path.join(dir, "backups");
    const backup = createOpenCodeBackup({ dataDir: dir, backupDir });
    const result = await backup.backupNow({ reason: "update" });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.match(result.file, /\.db\.gz$/);
    assert.ok(fs.existsSync(result.file));
    assert.ok(result.bytes > 0);
    assert.ok(result.bytes < result.rawBytes);

    const unpacked = path.join(dir, "restored.db");
    fs.writeFileSync(unpacked, zlib.gunzipSync(fs.readFileSync(result.file)));
    const { DatabaseSync } = require("node:sqlite");
    const copy = new DatabaseSync(unpacked, { readOnly: true });
    try {
      assert.deepEqual(copy.prepare("select count(*) as n from session_v2").get().n, 1);
      assert.equal(copy.prepare("pragma integrity_check").get().integrity_check, "ok");
    } finally {
      copy.close();
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retention removes the oldest snapshots", { skip: !sqliteAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-backup-retention-"));
  const db = makeDatabase(dir);
  try {
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of ["opencode-20000101-000000-000-old.db.gz", "opencode-20000102-000000-000-older.db.gz"]) {
      fs.writeFileSync(path.join(backupDir, name), "old");
    }
    const backup = createOpenCodeBackup({ dataDir: dir, backupDir, retention: 1 });
    const result = await backup.backupNow({ reason: "update" });
    assert.equal(result.ok, true);
    const names = fs.readdirSync(backupDir).sort();
    assert.equal(names.length, 1);
    assert.match(names[0], /^opencode-\d{8}-\d{6}-\d{3}-update\.db\.gz$/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reports snapshot usage and clears only its own backups", { skip: !sqliteAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-backup-clear-"));
  const db = makeDatabase(dir);
  try {
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "notes.txt"), "keep me");
    const backup = createOpenCodeBackup({ dataDir: dir, backupDir });
    const result = await backup.backupNow({ reason: "manual" });
    assert.equal(result.ok, true);
    const info = await backup.info();
    assert.equal(info.count, 1);
    assert.ok(info.bytes > 0);
    assert.equal(info.directory, backupDir);
    const cleared = await backup.clear();
    assert.equal(cleared.count, 0);
    assert.equal(cleared.bytes, 0);
    assert.ok(fs.existsSync(path.join(backupDir, "notes.txt")));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh snapshot is reused instead of copied again", { skip: !sqliteAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-backup-fresh-"));
  const db = makeDatabase(dir);
  try {
    const backup = createOpenCodeBackup({ dataDir: dir, backupDir: path.join(dir, "backups") });
    const first = await backup.backupNow({ reason: "daily" });
    assert.equal(first.ok, true);
    assert.equal(first.skipped, false);
    const second = await backup.backupNow({ reason: "daily", minIntervalMs: 60 * 60 * 1000 });
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "fresh");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
