const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolvePluginTarget, installPlugin, claudeSnippet } = require("../scripts/hooks-install.cjs");

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
