const os = require("node:os");

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function defaultShell() {
  if (isWindows) return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL || "/bin/bash";
}

function defaultCwd() {
  return os.homedir();
}

function isAbsoluteCwd(cwd) {
  return typeof cwd === "string" && os.platform() === "win32"
    ? /^[a-zA-Z]:[\\/]/.test(cwd) || /^[\\/]{2}/.test(cwd)
    : cwd.startsWith("/");
}

module.exports = { isWindows, isMac, defaultShell, defaultCwd, isAbsoluteCwd };
