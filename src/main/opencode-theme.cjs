// opencode paints its own full-screen TUI. TermBeacon can hand it a complete
// custom theme file so the interface matches the app palette instead of only
// following light/dark. opencode discovers themes at
// <config dir>/themes/<name>.json, and the parser is strict: a partial document
// is rejected, so every palette below starts from the built-in v2 "opencode"
// document (https://opencode.ai/theme.json) and only swaps the neutral ramp and
// accent colors. The template is embedded rather than read at runtime because
// packaged builds only copy the .cjs files listed in scripts/copy-runtime.mjs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEMPLATE = {"$schema":"https://opencode.ai/theme.json","base":{"categorical":["blue","purple","green","orange","red"],"text":{"base":"$hue.neutral.100","muted":"$hue.neutral.300","action":{"primary":{"base":"$text.base","$disabled":"$text.muted","$focused":"$text.base","$selected":"$hue.interactive.400"},"secondary":{"base":"$text.muted","$hovered":"$text.base","$focused":"$hue.interactive.200"},"destructive":{"base":"$hue.neutral.900","$disabled":"$text.muted"}},"formfield":{"base":"$text.base","$hovered":"$hue.interactive.400","$focused":"$hue.interactive.400","$pressed":"$hue.interactive.400","$disabled":"$text.muted","$selected":"$hue.interactive.400"},"feedback":{"error":{"base":"$hue.red.400"},"warning":{"base":"#f5a742"},"success":{"base":"$hue.green.400"},"info":{"base":"$hue.blue.400"}}},"background":{"base":"$hue.neutral.900","raised":{"base":"$hue.neutral.700","high":"$hue.neutral.600","max":"$hue.neutral.500"},"action":{"primary":{"base":"transparent","$hovered":"$hue.neutral.700","$focused":"$hue.interactive.600","$selected":"transparent"},"secondary":{"base":"transparent"},"destructive":{"base":"$hue.red.400"}},"formfield":{"base":"$background.base"},"feedback":{"error":{"base":"$background.base"},"warning":{"base":"$background.base"},"success":{"base":"$background.base"},"info":{"base":"$background.base"}}},"border":{"base":"#484848"},"scrollbar":{"base":"#606060"},"diff":{"text":{"added":"#4fd6be","removed":"#c53b53","context":"#828bb8","hunkHeader":"#828bb8"},"background":{"added":"#20303b","removed":"#37222c","context":"$hue.neutral.700"},"highlight":{"added":"#b8db87","removed":"#e26a75"},"lineNumber":{"text":"#8f8f8f","background":{"added":"#1b2b34","removed":"#2d1f26"}}},"syntax":{"comment":"#808080","keyword":"#9d7cd8","function":"#fab283","variable":"#e06c75","string":"#7fd88f","number":"#f5a742","type":"#e5c07b","operator":"#56b6c2","punctuation":"#eeeeee"},"markdown":{"text":"#eeeeee","heading":"#9d7cd8","link":"#fab283","linkText":"#56b6c2","code":"#7fd88f","blockQuote":"#e5c07b","emphasis":"#e5c07b","strong":"#f5a742","horizontalRule":"#808080","listItem":"#fab283","listEnumeration":"#56b6c2","image":"#fab283","imageText":"#56b6c2","codeBlock":"#eeeeee"},"@dialog":{"background":{"base":"$background.raised.base","action":{"primary":{"$hovered":"$background.raised.max"},"secondary":{"$hovered":"$background.raised.max"}}},"@footer":{"text":{"muted":"$hue.neutral.200"}}}},"light":{"hue":{"gray":{"100":"#101010","200":"#505050","300":"#808080","400":"#b5b5b5","500":"#e6e6e6","600":"#eeeeee","700":"#f2f2f2","800":"#fafafa","900":"#ffffff"},"blue":{"100":"#1b1f2e","200":"#6e7380","300":"#9ba1b2","400":"#6c8ffe","500":"#b9c9f5","600":"#d3ddf8","700":"#eaf0ff","800":"#f4f7ff","900":"#fbfcff"},"orange":{"100":"#2e241b","200":"#7d7670","300":"#afa49d","400":"#c4713a","500":"#e8c7ad","600":"#f0dcce","700":"#fcf2ea","800":"#fdf8f4","900":"#fefdfb"},"purple":{"100":"#231b2e","200":"#74707c","300":"#a29dae","400":"#9d78df","500":"#cdbee7","600":"#e8e0f8","700":"#f0ebfa","800":"#f8f5fc","900":"#fcfbfe"},"red":{"100":"#2e1b1b","200":"#7e6d6d","300":"#b09999","400":"#ec6262","500":"#eab8b8","600":"#fbdada","700":"#fdeaea","800":"#fff6f6","900":"#fffbfb"},"green":{"100":"#1b2e1b","200":"#6d7e6d","300":"#99b099","400":"#62ec62","500":"#b8eab8","600":"#dafbda","700":"#eafdea","800":"#f6fff6","900":"#fbfffb"},"accent":"$hue.blue","interactive":"$hue.blue","neutral":"$hue.gray"},"text":{"feedback":{"warning":{"base":"#d68c27"}}},"border":{"base":"#b8b8b8"},"scrollbar":{"base":"#a0a0a0"},"diff":{"text":{"added":"#1e725c","removed":"#c53b53","context":"#7086b5","hunkHeader":"#7086b5"},"background":{"added":"#d5e5d5","removed":"#f7d8db","context":"$hue.neutral.700"},"highlight":{"added":"#4db380","removed":"#f52a65"},"lineNumber":{"text":"#595959","background":{"added":"#c5d5c5","removed":"#e7c8cb"}}},"syntax":{"comment":"#8a8a8a","keyword":"#d68c27","function":"#3b7dd8","variable":"#d1383d","string":"#3d9a57","number":"#d68c27","type":"#b0851f","operator":"#318795","punctuation":"#1a1a1a"},"markdown":{"text":"#1a1a1a","heading":"#d68c27","link":"#3b7dd8","linkText":"#318795","code":"#3d9a57","blockQuote":"#b0851f","emphasis":"#b0851f","strong":"#d68c27","horizontalRule":"#8a8a8a","listItem":"#3b7dd8","listEnumeration":"#318795","image":"#3b7dd8","imageText":"#318795","codeBlock":"#1a1a1a"},"@dialog":{"background":{"base":"$hue.neutral.800","raised":{"high":"$hue.neutral.700"},"action":{"primary":{"$hovered":"$hue.neutral.600"},"secondary":{"$hovered":"$hue.neutral.600"}}}}},"dark":{"hue":{"gray":{"100":"#ffffff","200":"#b0b0b0","300":"#808080","400":"#444444","500":"#303030","600":"#202020","700":"#141414","800":"#101010","900":"#080808"},"blue":{"100":"#f1f4ff","200":"#93a2b7","300":"#6d7a8d","400":"#7699fe","500":"#426097","600":"#23344b","700":"#162333","800":"#0d1621","900":"#050a12"},"orange":{"100":"#f6f0eb","200":"#b09c8d","300":"#807770","400":"#ecb081","500":"#896b50","600":"#42372c","700":"#2c241d","800":"#1b1612","900":"#0d0907"},"purple":{"100":"#f7f2ff","200":"#af9eba","300":"#7d7492","400":"#a383e2","500":"#685588","600":"#3b3347","700":"#241e2c","800":"#130f18","900":"#0c080e"},"red":{"100":"#fff2f2","200":"#b09492","300":"#90706f","400":"#ef6c6c","500":"#90494a","600":"#4a2e2e","700":"#2e1f1f","800":"#1a1313","900":"#0d0909"},"green":{"100":"#f1f1f1","200":"#c5cfc5","300":"#8f9c8f","400":"#9ee77a","500":"#499049","600":"#2c422c","700":"#1f2e1f","800":"#131a13","900":"#090d09"},"accent":"$hue.blue","interactive":"$hue.blue","neutral":"$hue.gray"}}};

// TermBeacon palettes, mirrored from src/renderer/styles.css. Keeping the
// values here means the generated theme needs no renderer round-trip.
const PALETTES = {
  dark: {
    mode: "dark",
    appBg: "#101215",
    panelBg: "#15181c",
    panelSoft: "#1b1f24",
    panelActive: "#20262d",
    border: "#292e35",
    borderStrong: "#3c4855",
    text: "#e7eaf0",
    textSoft: "#bdc4ce",
    muted: "#8c97a5",
    accent: "#6aa9e9",
    danger: "#f08080",
  },
  light: {
    mode: "light",
    appBg: "#f5f6f8",
    panelBg: "#f8f9fb",
    panelSoft: "#eef1f4",
    panelActive: "#e6edf4",
    border: "#dce1e7",
    borderStrong: "#b9c5d1",
    text: "#20252c",
    textSoft: "#414b57",
    muted: "#657180",
    accent: "#2563a8",
    danger: "#b83f46",
  },
  sepia: {
    mode: "light",
    appBg: "#f4ecdc",
    panelBg: "#f9f3e6",
    panelSoft: "#efe6d2",
    panelActive: "#e9dec4",
    border: "#ddd0b6",
    borderStrong: "#bfae8c",
    text: "#3a3226",
    textSoft: "#574c39",
    muted: "#7a6f58",
    accent: "#9a6b2f",
    danger: "#b83f46",
  },
};

const PALETTE_MODES = {
  dark: "dark",
  light: "light",
  sepia: "light",
};

function themeName(palette) {
  return `termbeacon-${palette}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// The gray ramp is the page: 100 is primary text, 300 secondary text, 400
// strong borders, 500 borders, 600-800 raised surfaces, 900 the canvas. Both
// light and dark template ramps order it from text to canvas, so the same
// mapping works for every palette.
function neutralRamp(palette) {
  return {
    100: palette.text,
    200: palette.textSoft,
    300: palette.muted,
    400: palette.borderStrong,
    500: palette.border,
    600: palette.panelActive,
    700: palette.panelSoft,
    800: palette.panelBg,
    900: palette.appBg,
  };
}

function buildThemeDocument(palette) {
  const source = PALETTES[palette];
  if (!source) throw new Error(`unknown TermBeacon palette: ${palette}`);
  const theme = clone(TEMPLATE);
  const mode = source.mode;
  const section = theme[mode] || (theme[mode] = {});
  section.hue = {
    ...(section.hue || {}),
    gray: neutralRamp(source),
    blue: {
      ...((TEMPLATE[mode] && TEMPLATE[mode].hue && TEMPLATE[mode].hue.blue) || {}),
      300: source.accent,
      400: source.accent,
    },
    red: {
      ...((TEMPLATE[mode] && TEMPLATE[mode].hue && TEMPLATE[mode].hue.red) || {}),
      400: source.danger,
    },
  };
  // The light template section pins a cool gray border; retarget it to the
  // palette so paper and light themes do not keep slate edges.
  section.border = { base: source.border };
  section.scrollbar = { base: source.borderStrong };
  return theme;
}

function resolveConfigDir({ home = os.homedir(), env = process.env } = {}) {
  return env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
}

// Writes the selected palette into opencode's theme directory. The write is
// idempotent so spawning several terminals does not repaint the disk each time.
function syncOpencodeThemes({ home = os.homedir(), env = process.env, palettes = Object.keys(PALETTES) } = {}) {
  const themesDir = path.join(resolveConfigDir({ home, env }), "themes");
  fs.mkdirSync(themesDir, { recursive: true });
  for (const palette of palettes) {
    if (!PALETTES[palette]) continue;
    const file = path.join(themesDir, `${themeName(palette)}.json`);
    const content = `${JSON.stringify(buildThemeDocument(palette), null, 2)}\n`;
    let existing;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      existing = undefined;
    }
    if (existing === content) continue;
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, "utf8");
    try {
      fs.renameSync(temporary, file);
    } catch {
      fs.rmSync(file, { force: true });
      fs.renameSync(temporary, file);
    }
  }
  return themesDir;
}

module.exports = {
  PALETTES,
  PALETTE_MODES,
  buildThemeDocument,
  resolveConfigDir,
  syncOpencodeThemes,
  themeName,
};
