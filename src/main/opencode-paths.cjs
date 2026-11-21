const os = require("node:os");
const path = require("node:path");

// OpenCode follows XDG on every platform it supports: when XDG_DATA_HOME is
// set its data lives under <xdg>/opencode, otherwise it uses the per-user data
// directory shown by `opencode debug paths`. Keeping this resolution in one
// place lets recovery and backup agree on the database they operate on.
function resolveOpenCodeDataDir({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const xdg = typeof env.XDG_DATA_HOME === "string" ? env.XDG_DATA_HOME.trim() : "";
  if (xdg) return path.join(xdg, "opencode");
  if (platform === "win32") return path.join(home, ".local", "share", "opencode");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "opencode");
  return path.join(home, ".local", "share", "opencode");
}

function openCodeDatabasePath(dataDir) {
  return path.join(dataDir, "opencode.db");
}

module.exports = { resolveOpenCodeDataDir, openCodeDatabasePath };
