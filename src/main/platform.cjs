const os = require("node:os");
const path = require("node:path");

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function defaultShell(env = process.env) {
  // PowerShell is the default interactive shell on Windows. cmd.exe remains
  // available as an explicit setting for projects that need it.
  if (isWindows) return "powershell.exe";
  if (typeof env.SHELL === "string" && path.isAbsolute(env.SHELL)) return env.SHELL;
  return isMac ? "/bin/zsh" : "/bin/bash";
}

function defaultCwd() {
  return os.homedir();
}

function isAbsoluteCwd(cwd) {
  if (typeof cwd !== "string") return false;
  return isWindows ? path.win32.isAbsolute(cwd) : path.posix.isAbsolute(cwd);
}

function platformInfo() {
  return {
    platform: process.platform,
    isWindows,
    isMac,
    shell: defaultShell(),
    cwd: defaultCwd(),
  };
}

module.exports = { isWindows, isMac, defaultShell, defaultCwd, isAbsoluteCwd, platformInfo };
