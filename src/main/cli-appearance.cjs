const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PALETTE_MODES, syncOpencodeThemes, themeName } = require("./opencode-theme.cjs");

// opencode paints its entire viewport with its own palette. On Windows it never
// asks the terminal for its background colour (no OSC 10/11 query, no
// COLORFGBG), so the only way to make the TUI match TermBeacon's theme is to
// hand it the light/dark intent when the shell starts. `--standalone` sessions
// merge this inline CLI config over the user's cli.json, so nothing is written
// to their files; an explicit theme.mode in cli.json always wins and is left
// untouched.
function stripComments(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function stripTrailingCommas(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    out += char;
  }
  return out;
}

// cli.json is JSONC, so a plain JSON.parse would reject the comments users are
// invited to keep. Returns undefined when the document cannot be read at all.
function parseJsonc(source) {
  const normalized = stripTrailingCommas(stripComments(source)).replace(/^\uFEFF/, "").trim();
  if (!normalized) return undefined;
  try {
    return JSON.parse(normalized);
  } catch {
    return undefined;
  }
}

function resolveCliConfigPath({ home = os.homedir(), env = process.env } = {}) {
  const configDir = env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  return path.join(configDir, "cli.json");
}

// True when the user already owns this decision: a present theme.mode, an
// unreadable file, or a cli.json we cannot parse (do not override what we cannot
// see). A missing file means the CLI is still on its default dark mode.
function themeModeConfigured(options) {
  const choice = readThemeChoice(options);
  return choice === "configured" || choice === "legacy" || choice === "unreadable";
}

// Describes how much of the theme the user has already chosen:
// "absent" (no theme at all), "named" (name only, mode still free),
// "configured" (a mode is set), "legacy" (old scalar theme) or "unreadable".
function readThemeChoice({ home = os.homedir(), env = process.env } = {}) {
  let text;
  try {
    text = fs.readFileSync(resolveCliConfigPath({ home, env }), "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "unreadable";
  }
  const config = parseJsonc(text);
  if (!config) return "unreadable";
  const theme = config?.theme;
  if (theme === undefined) return "absent";
  // A legacy scalar theme ("tokyonight") would be replaced wholesale by our
  // inline object, so leave it alone instead of guessing at its mode.
  if (typeof theme !== "object" || theme === null) return "legacy";
  return typeof theme.mode === "string" ? "configured" : "named";
}

function buildCliAppearanceEnv(mode, { home = os.homedir(), env = process.env } = {}) {
  if (mode !== "light" && mode !== "dark") return {};
  // An inline config from the user's own environment outranks ours.
  if (typeof env.OPENCODE_CLI_CONFIG_CONTENT === "string" && env.OPENCODE_CLI_CONFIG_CONTENT.trim()) return {};
  if (themeModeConfigured({ home, env })) return {};
  return { OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode } }) };
}

// Hands opencode a complete custom theme so its whole viewport matches the
// TermBeacon palette, not just the light/dark axis. The theme file is written
// into opencode's own themes directory because that is the only discovery path
// it offers; the name is namespaced so it cannot collide with a user theme.
// When the user has any theme preference of their own, we fall back to the
// pre-existing mode-only behaviour (or stay out of the way entirely).
function buildOpencodeThemeEnv(palette, { home = os.homedir(), env = process.env } = {}) {
  const mode = PALETTE_MODES[palette];
  if (!mode) return {};
  if (typeof env.OPENCODE_CLI_CONFIG_CONTENT === "string" && env.OPENCODE_CLI_CONFIG_CONTENT.trim()) return {};
  const choice = readThemeChoice({ home, env });
  if (choice === "configured" || choice === "legacy" || choice === "unreadable") return {};
  if (choice === "named") return { OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode } }) };
  try {
    syncOpencodeThemes({ home, env, palettes: [palette] });
  } catch {
    // If the theme file cannot be written, keep following light/dark rather
    // than pointing opencode at a theme that does not exist.
    return { OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { mode } }) };
  }
  return { OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { name: themeName(palette), mode } }) };
}

module.exports = { buildCliAppearanceEnv, buildOpencodeThemeEnv, parseJsonc, readThemeChoice, resolveCliConfigPath, themeModeConfigured };
