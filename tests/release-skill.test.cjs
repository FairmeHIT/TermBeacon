const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const scriptPath = path.join(__dirname, "..", ".opencode", "skills", "release", "scripts", "create-release.mjs");
const script = () => import(pathToFileURL(scriptPath).href);

test("release script exports helpers without running main", async () => {
  const module = await script();
  assert.equal(typeof module.parseArgs, "function");
  assert.equal(typeof module.parseLatestYml, "function");
  assert.equal(typeof module.sha512File, "function");
});

test("parseArgs reads the documented flags", async () => {
  const { parseArgs } = await script();
  const args = parseArgs(["--version", "0.1.9", "--notes-file", "notes.md", "--verify-download", "--dry-run"]);
  assert.deepEqual(args, {
    version: "0.1.9",
    notesFile: "notes.md",
    repo: undefined,
    dryRun: true,
    verifyOnly: false,
    verifyDownload: true,
    help: false,
  });
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("parseLatestYml reads electron-builder's updater manifest", async () => {
  const { parseLatestYml } = await script();
  const parsed = parseLatestYml(`version: 0.1.8
files:
  - url: TermBeacon-0.1.8-setup.exe
    sha512: abc==
    size: 12345
path: TermBeacon-0.1.8-setup.exe
sha512: abc==
releaseDate: '2026-11-06T11:30:22.818Z'
`);
  assert.equal(parsed.version, "0.1.8");
  assert.equal(parsed.path, "TermBeacon-0.1.8-setup.exe");
  assert.equal(parsed.sha512, "abc==");
  assert.deepEqual(parsed.files, [{ url: "TermBeacon-0.1.8-setup.exe", sha512: "abc==", size: 12345 }]);
});

test("sha512File matches the hash format electron-builder writes", async () => {
  const { sha512File } = await script();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-release-"));
  const file = path.join(dir, "setup.exe");
  fs.writeFileSync(file, "termbeacon-release-fixture");
  const expected = crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
  assert.equal(sha512File(file), expected);
  fs.rmSync(dir, { recursive: true, force: true });
});