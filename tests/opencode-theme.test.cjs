const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PALETTES,
  PALETTE_MODES,
  buildThemeDocument,
  resolveConfigDir,
  syncOpencodeThemes,
  themeName,
} = require("../src/main/opencode-theme.cjs");

test("every TermBeacon palette maps to a complete opencode theme document", () => {
  assert.deepEqual(Object.keys(PALETTES).sort(), ["dark", "light", "sepia"]);
  assert.deepEqual(PALETTE_MODES, { dark: "dark", light: "light", sepia: "light" });

  for (const [palette, source] of Object.entries(PALETTES)) {
    const document = buildThemeDocument(palette);
    assert.equal(document.base.categorical.length, 5, `${palette}: base section copied`);
    assert.match(document.base.background.base, /^\$hue\./, `${palette}: background references the ramp`);
    const section = document[source.mode];
    assert.ok(section, `${palette}: ${source.mode} section exists`);
    assert.deepEqual(Object.keys(section.hue.gray), ["100", "200", "300", "400", "500", "600", "700", "800", "900"]);
    assert.equal(section.hue.gray["900"], source.appBg);
    assert.equal(section.hue.gray["100"], source.text);
    assert.equal(section.hue.blue["300"], source.accent);
    assert.equal(section.hue.red["400"], source.danger);
    assert.equal(section.border.base, source.border);
    assert.equal(section.scrollbar.base, source.borderStrong);
  }
  assert.throws(() => buildThemeDocument("midnight"), /unknown TermBeacon palette/);
});

test("theme names are namespaced so they cannot collide with user themes", () => {
  assert.equal(themeName("dark"), "termbeacon-dark");
  assert.equal(themeName("sepia"), "termbeacon-sepia");
});

test("config directory honours opencode's own environment overrides", () => {
  const home = path.join(os.tmpdir(), "tb-home");
  assert.equal(resolveConfigDir({ home, env: { OPENCODE_CONFIG_DIR: "C:\\custom" } }), "C:\\custom");
  assert.equal(resolveConfigDir({ home, env: { XDG_CONFIG_HOME: "D:\\xdg" } }), path.join("D:\\xdg", "opencode"));
  assert.equal(resolveConfigDir({ home, env: {} }), path.join(home, ".config", "opencode"));
});

test("syncing writes only the requested palettes and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-opencode-theme-"));
  const env = { OPENCODE_CONFIG_DIR: dir };
  const themesDir = syncOpencodeThemes({ env, palettes: ["sepia"] });
  assert.equal(themesDir, path.join(dir, "themes"));
  const file = path.join(themesDir, "termbeacon-sepia.json");
  const content = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(content), buildThemeDocument("sepia"));
  assert.equal(fs.existsSync(path.join(themesDir, "termbeacon-dark.json")), false);

  // A second pass with unchanged content must not rewrite the file.
  const before = fs.statSync(file).mtimeMs;
  syncOpencodeThemes({ env, palettes: ["sepia"] });
  assert.equal(fs.statSync(file).mtimeMs, before);

  syncOpencodeThemes({ env, palettes: ["dark", "unknown"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(themesDir, "termbeacon-dark.json"), "utf8")), buildThemeDocument("dark"));
  assert.equal(fs.existsSync(path.join(themesDir, "termbeacon-unknown.json")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
