const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { isWindows } = require("./platform.cjs");

const targets = {
  opencode: "opencode",
  codex: "codex",
  claude: "claude",
};

function discoveryPath(env = process.env) {
  const entries = new Set(String(env?.PATH || "").split(path.delimiter).filter(Boolean));
  if (process.platform === "darwin") {
    const home = os.homedir();
    for (const directory of [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".asdf", "shims"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
    ]) entries.add(directory);
  }
  return [...entries].join(path.delimiter);
}

function commandEnvironment() {
  return { ...(process.env || {}), PATH: discoveryPath() };
}

function firstOutputLine(value) {
  return String(value || "").trim().split(/\r?\n/)[0]?.slice(0, 160) || undefined;
}

function locate(name) {
  try {
    if (isWindows) {
      const output = execFileSync("where.exe", [name], { encoding: "utf8", timeout: 3000, windowsHide: true, env: commandEnvironment() });
      const paths = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return paths.find((value) => /\.(cmd|exe)$/i.test(value)) || paths[0];
    }
    const output = execFileSync("which", [name], { encoding: "utf8", timeout: 3000, env: commandEnvironment() });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

function version(name, executable = name) {
  try {
    if (isWindows) {
      const shell = process.env.ComSpec || "cmd.exe";
      const output = execFileSync(shell, ["/d", "/s", "/c", name + " --version"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: false,
        env: commandEnvironment(),
      });
      return firstOutputLine(output);
    }
    const output = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, env: commandEnvironment() });
    return firstOutputLine(output);
  } catch (error) {
    return firstOutputLine(error?.stdout);
  }
}

function discoverAll() {
  return Object.fromEntries(Object.entries(targets).map(([id, command]) => {
    const executable = locate(command);
    return [id, { id, command, installed: Boolean(executable), executable, version: executable ? version(command, executable) : undefined }];
  }));
}

module.exports = { discoverAll, locate, version, discoveryPath, firstOutputLine };
