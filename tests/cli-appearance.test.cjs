const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCliAppearanceEnv, parseJsonc } = require("../src/main/cli-appearance.cjs");

function withConfig(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-appearance-"));
  if (text !== undefined) fs.writeFileSync(path.join(dir, "cli.json"), text);
  return { dir, env: { OPENCODE_CONFIG_DIR: dir } };
}

test("cli.json is parsed as JSONC", () => {
  const parsed = parseJsonc(`\uFEFF{
    // keep the schema for editor completion
    "$schema": "https://opencode.ai/v2/cli.json",
    /* nested block comment */
    "theme": { "name": "github", "mode": "dark" },
    "url": "https://example.test/a//b",
    "plugins": ["-opencode.notifications",],
  }`);
  assert.deepEqual(parsed, {
    $schema: "https://opencode.ai/v2/cli.json",
    theme: { name: "github", mode: "dark" },
    url: "https://example.test/a//b",
    plugins: ["-opencode.notifications"],
  });
  assert.equal(parseJsonc("{ this is not json"), undefined);
});

test("appearance env is injected only when the user has not chosen a theme mode", () => {
  const empty = withConfig(undefined);
  assert.deepEqual(buildCliAppearanceEnv("light", { env: empty.env }), {
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode: "light" } }),
  });
  assert.deepEqual(buildCliAppearanceEnv("dark", { env: empty.env }), {
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode: "dark" } }),
  });

  const explicit = withConfig('{ "theme": { "name": "tokyonight", "mode": "dark" } }');
  assert.deepEqual(buildCliAppearanceEnv("light", { env: explicit.env }), {});

  // A name without a mode keeps the user's palette and only fills in the mode.
  const named = withConfig('{ "theme": { "name": "tokyonight" } }');
  assert.deepEqual(buildCliAppearanceEnv("light", { env: named.env }), {
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode: "light" } }),
  });

  // Settings the app cannot read are left alone.
  const broken = withConfig("{ not json");
  assert.deepEqual(buildCliAppearanceEnv("light", { env: broken.env }), {});

  // Legacy scalar themes would be replaced by an inline object, so skip them.
  const legacy = withConfig('{ "theme": "tokyonight" }');
  assert.deepEqual(buildCliAppearanceEnv("light", { env: legacy.env }), {});

  // The user's own inline config always wins.
  assert.deepEqual(buildCliAppearanceEnv("light", {
    env: { ...empty.env, OPENCODE_CLI_CONFIG_CONTENT: '{"theme":{"mode":"dark"}}' },
  }), {});

  assert.deepEqual(buildCliAppearanceEnv("sepia", { env: empty.env }), {});
  for (const dir of [empty.dir, explicit.dir, named.dir, broken.dir, legacy.dir]) fs.rmSync(dir, { recursive: true, force: true });
});
