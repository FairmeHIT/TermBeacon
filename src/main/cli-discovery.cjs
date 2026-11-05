const { execFileSync } = require("node:child_process");

const targets = {
  opencode: "opencode",
  codex: "codex",
  claude: "claude",
};

function locate(name) {
  try {
    const output = execFileSync("where.exe", [name], { encoding: "utf8", timeout: 3000, windowsHide: true });
    const paths = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return paths.find((value) => /\.(cmd|exe)$/i.test(value)) || paths[0];
  } catch {
    return undefined;
  }
}

function version(name) {
  try {
    const output = execFileSync(name, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: true });
    return output.trim().split(/\r?\n/)[0].slice(0, 160);
  } catch (error) {
    return error?.stdout?.toString().trim().split(/\r?\n/)[0]?.slice(0, 160);
  }
}

function discoverAll() {
  return Object.fromEntries(Object.entries(targets).map(([id, command]) => {
    const executable = locate(command);
    return [id, { id, command, installed: Boolean(executable), executable, version: executable ? version(command) : undefined }];
  }));
}

module.exports = { discoverAll, locate, version };
