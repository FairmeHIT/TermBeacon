const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveAssets,
  installOpencodePlugin,
  mergeClaudeSettings,
  configureClaude,
  integrationStatus,
} = require("../src/main/integration-config.cjs");

const repoRoot = path.join(__dirname, "..");

test("development assets resolve from the repository", () => {
  const assets = resolveAssets({ packaged: false, appPath: repoRoot });
  assert.ok(fs.existsSync(assets.opencodePlugin));
  assert.ok(fs.existsSync(assets.hookScript));
});

test("installs the packaged-style opencode plugin idempotently", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-integration-"));
  const source = path.join(home, "source-plugin.js");
  const assets = { opencodePlugin: source, hookScript: path.join(home, "hook.cjs") };
  fs.writeFileSync(source, "plugin");
  fs.writeFileSync(assets.hookScript, "hook");
  try {
    const first = installOpencodePlugin({ assets, home });
    const second = installOpencodePlugin({ assets, home });
    assert.equal(first.existed, false);
    assert.equal(second.existed, true);
    assert.equal(fs.readFileSync(second.target, "utf8"), "plugin");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Claude settings merge preserves existing hooks and avoids duplicates", () => {
  const existing = { permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "node other.cjs" }] }] } };
  const once = mergeClaudeSettings(existing, "C:\\Program Files\\TermBeacon\\termbeacon-hook.cjs");
  const twice = mergeClaudeSettings(once, "C:\\Program Files\\TermBeacon\\termbeacon-hook.cjs");
  assert.deepEqual(once.permissions, existing.permissions);
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(twice.hooks.Stop.length, 2);
  assert.match(twice.hooks.Stop[1].hooks[0].command, /Program Files\/TermBeacon\/termbeacon-hook\.cjs/);
});

test("Claude configuration writes an atomic file and keeps a backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-claude-"));
  const target = path.join(home, ".claude", "settings.json");
  const assets = { opencodePlugin: path.join(home, "plugin.js"), hookScript: path.join(home, "termbeacon-hook.cjs") };
  fs.writeFileSync(assets.hookScript, "hook");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ permissions: { allow: ["Read"] } }));
    const result = configureClaude({ assets, target });
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.deepEqual(parsed.permissions, { allow: ["Read"] });
    assert.ok(parsed.hooks.Stop[0].hooks[0].command.includes("termbeacon-hook.cjs"));
    assert.equal(integrationStatus({ assets, home }).claudeHookConfigured, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
