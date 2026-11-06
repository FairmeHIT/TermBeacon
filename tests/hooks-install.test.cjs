const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolvePluginTarget, installPlugin, claudeSnippet, mergeClaudeSettings, configureClaude } = require("../scripts/hooks-install.cjs");

const repoRoot = path.join(__dirname, "..");
const pluginSource = path.join(repoRoot, "hooks", "opencode", "termbeacon.js");

test("resolves the global plugin path under the user home", () => {
  const target = resolvePluginTarget({ home: "C:\\Users\\someone", cwd: "C:\\work" });
  assert.equal(target, path.join("C:\\Users\\someone", ".config", "opencode", "plugin", "termbeacon.js"));
});

test("resolves the project plugin path under the working directory", () => {
  const target = resolvePluginTarget({ project: true, home: "C:\\Users\\someone", cwd: "C:\\work" });
  assert.equal(target, path.join("C:\\work", ".opencode", "plugin", "termbeacon.js"));
});

test("installs the plugin byte-for-byte and is idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-hooks-"));
  try {
    const first = installPlugin({ home });
    assert.equal(first.existed, false);
    assert.ok(fs.existsSync(first.target));
    assert.deepEqual(fs.readFileSync(first.target), fs.readFileSync(pluginSource));

    const second = installPlugin({ home });
    assert.equal(second.existed, true);
    assert.deepEqual(fs.readFileSync(second.target), fs.readFileSync(pluginSource));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("prints a Claude snippet with the real absolute hook path", () => {
  const snippet = claudeSnippet();
  assert.ok(!snippet.includes("C:/path/to/TermBeacon"));
  assert.ok(snippet.includes("termbeacon-hook.cjs"));
  assert.ok(snippet.includes(repoRoot.replace(/\\/g, "/")));
  const parsed = JSON.parse(snippet);
  assert.ok(parsed.hooks.Stop[0].hooks[0].command.includes("termbeacon-hook.cjs"));
});

test("merges Claude hooks without duplicating existing TermBeacon commands", () => {
  const existing = { theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "node other.cjs" }] }] } };
  const addition = JSON.parse(claudeSnippet());
  const once = mergeClaudeSettings(existing, addition);
  const twice = mergeClaudeSettings(once, addition);
  assert.equal(once.theme, "dark");
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.Stop[0].hooks[0].command, "node other.cjs");
  assert.ok(once.hooks.Stop[1].hooks[0].command.includes("termbeacon-hook.cjs"));
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.Stop.filter((group) => group.hooks.some((hook) => hook.command.includes("termbeacon-hook.cjs"))).length, 1);
  assert.ok(twice.hooks.UserPromptSubmit.length > 0);
});

test("configureClaude writes atomically and preserves a backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-claude-"));
  const target = path.join(home, ".claude", "settings.json");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ permissions: { allow: ["Read"] } }), "utf8");
    const result = configureClaude({ target, root: repoRoot });
    assert.equal(result.target, target);
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.deepEqual(parsed.permissions, { allow: ["Read"] });
    assert.ok(parsed.hooks.Stop[0].hooks[0].command.includes("termbeacon-hook.cjs"));
    configureClaude({ target, root: repoRoot });
    const second = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(second.hooks.Stop.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("configureClaude leaves invalid JSON untouched", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-claude-invalid-"));
  const target = path.join(home, "settings.json");
  const original = "{ invalid json";
  try {
    fs.writeFileSync(target, original, "utf8");
    assert.throws(() => configureClaude({ target, root: repoRoot }));
    assert.equal(fs.readFileSync(target, "utf8"), original);
    assert.equal(fs.readdirSync(home).filter((name) => name.includes(".bak-")).length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
