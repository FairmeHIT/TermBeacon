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
  configureAgent,
  agentIntegrationStatus,
} = require("../src/main/integration-config.cjs");

test("OpenCode integration archives only owned legacy copies and installs a single package", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-plugin-migrate-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const assets = resolveAssets({ appPath: path.resolve(__dirname, "..") });
  const legacy = path.join(home, ".config", "opencode", "plugin", "termbeacon.js");
  const unrelated = path.join(home, ".config", "opencode", "plugins", "termbeacon.js");
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(legacy, 'export default { id: "termbeacon" }; // TERMBEACON_HOOK_PORT');
  fs.writeFileSync(unrelated, "// user-owned plugin");
  const result = configureAgent({ id: "opencode", assets, home, env: {} });
  assert.equal(result.migrated.length, 1);
  assert.ok(fs.existsSync(result.migrated[0]));
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "// user-owned plugin");
  assert.equal(agentIntegrationStatus({ id: "opencode", assets, home, env: {} }).state, "configured");
});

test("integration honors explicit CLI configuration directories", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-config-dirs-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const assets = resolveAssets({ appPath: path.resolve(__dirname, "..") });
  const env = { OPENCODE_CONFIG_DIR: path.join(home, "oc"), CLAUDE_CONFIG_DIR: path.join(home, "cc"), PI_CODING_AGENT_DIR: path.join(home, "pi") };
  for (const id of ["opencode", "claude", "pi"]) {
    const result = configureAgent({ id, assets, home, env });
    assert.equal(result.target.startsWith(env[{ opencode: "OPENCODE_CONFIG_DIR", claude: "CLAUDE_CONFIG_DIR", pi: "PI_CODING_AGENT_DIR" }[id]]), true);
    assert.equal(agentIntegrationStatus({ id, assets, home, env }).state, "configured");
  }
});

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
    assert.equal(agentIntegrationStatus({ id: "claude", assets, home }).state, "configured");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Claude migration removes owned child hooks and updates an old script path", () => {
  const own = { type: "command", command: 'node "C:/old/termbeacon-hook.cjs"' };
  const other = { type: "command", command: "node other.cjs" };
  const existing = { hooks: { SubagentStop: [{ matcher: "*", hooks: [own, other] }], Stop: [{ hooks: [own] }] } };
  const result = mergeClaudeSettings(existing, "C:/new/termbeacon-hook.cjs");
  assert.deepEqual(result.hooks.SubagentStop, [{ matcher: "*", hooks: [other] }]);
  assert.match(result.hooks.Stop[0].hooks[0].command, /C:\/new\//);
  assert.ok(result.hooks.PermissionRequest);
  assert.ok(result.hooks.SessionEnd);
  assert.equal(existing.hooks.SubagentStop[0].hooks.length, 2);
});

test("packaged Claude hooks stay idempotent and are recognized by preflight", () => {
  const command = '"C:/Program Files/TermBeacon/TermBeacon.exe" --hook';
  const once = mergeClaudeSettings({}, "unused", command);
  const twice = mergeClaudeSettings(once, "unused", command);
  assert.deepEqual(twice, once);
  const { isTermBeaconHook } = require("../src/main/integration-config.cjs");
  assert.equal(isTermBeaconHook(once.hooks.Stop[0].hooks[0]), true);
  assert.equal(isTermBeaconHook({ command: '"/Applications/TermBeacon.app/Contents/MacOS/TermBeacon" --hook' }), true);
  assert.equal(isTermBeaconHook({ command: '"C:/TermBeacon/another.exe" --hook' }), false);
});
