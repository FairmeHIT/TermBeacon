const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCliAppearanceEnv, buildOpencodeThemeEnv, parseJsonc } = require("../src/main/cli-appearance.cjs");
const { buildThemeDocument } = require("../src/main/opencode-theme.cjs");

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

test("opencode theme env writes a complete palette theme and selects it by name", () => {
  const empty = withConfig(undefined);
  const env = buildOpencodeThemeEnv("dark", { env: empty.env });
  assert.deepEqual(env, {
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { name: "termbeacon-dark", mode: "dark" } }),
  });
  const file = path.join(empty.dir, "themes", "termbeacon-dark.json");
  assert.ok(fs.existsSync(file), "theme file must be written next to cli.json");
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(document, buildThemeDocument("dark"));
  assert.ok(document.base, "theme must keep the complete v2 base section");
  assert.equal(document.dark.hue.gray["900"], "#101215");
  assert.equal(document.dark.hue.gray["100"], "#e7eaf0");
  assert.equal(document.dark.hue.blue["300"], "#6aa9e9");

  // sepia shares the light template section but keeps its own canvas.
  const sepia = buildOpencodeThemeEnv("sepia", { env: empty.env });
  assert.deepEqual(sepia, {
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { name: "termbeacon-sepia", mode: "light" } }),
  });
  const sepiaDoc = JSON.parse(fs.readFileSync(path.join(empty.dir, "themes", "termbeacon-sepia.json"), "utf8"));
  assert.equal(sepiaDoc.light.hue.gray["900"], "#f4ecdc");
  assert.equal(sepiaDoc.light.hue.gray["100"], "#3a3226");

  assert.deepEqual(buildOpencodeThemeEnv("midnight", { env: empty.env }), {});
  fs.rmSync(empty.dir, { recursive: true, force: true });
});

test("opencode theme env keeps the user's own theme choice", () => {
  // A named palette keeps its colors and only receives the matching mode.
  const named = withConfig('{ "theme": { "name": "tokyonight" } }');
  assert.deepEqual(buildOpencodeThemeEnv("dark", { env: named.env }), {
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode: "dark" } }),
  });
  assert.equal(fs.existsSync(path.join(named.dir, "themes", "termbeacon-dark.json")), false);

  // A complete user theme, an unreadable file, a legacy scalar and inline
  // config all win over the TermBeacon palette.
  const explicit = withConfig('{ "theme": { "name": "tokyonight", "mode": "dark" } }');
  const broken = withConfig("{ not json");
  const legacy = withConfig('{ "theme": "tokyonight" }');
  const inline = withConfig(undefined);
  for (const options of [
    explicit.env,
    broken.env,
    legacy.env,
    { ...inline.env, OPENCODE_CLI_CONFIG_CONTENT: '{"theme":{"mode":"light"}}' },
  ]) {
    assert.deepEqual(buildOpencodeThemeEnv("light", { env: options }), {});
  }
  for (const dir of [named.dir, explicit.dir, broken.dir, legacy.dir, inline.dir]) fs.rmSync(dir, { recursive: true, force: true });
});
