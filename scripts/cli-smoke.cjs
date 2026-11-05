const pty = require("node-pty");
const { discoverAll } = require("../src/main/cli-discovery.cjs");

const TIMEOUT_MS = 8000;

function stripTerminalControls(value) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

function runVersion(command) {
  return new Promise((resolve) => {
    const shell = process.env.ComSpec || "cmd.exe";
    const child = pty.spawn(shell, ["/d", "/s", "/c", command + " --version"], {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: process.cwd(),
      env: process.env,
      useConpty: true,
    });
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, pid: child.pid, output: stripTerminalControls(output).trim().slice(0, 400), ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* the host may already have exited */ }
      finish({ timeout: true });
    }, TIMEOUT_MS);
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode, signal }) => finish({ exitCode, signal }));
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.error("CLI smoke requires Windows ConPTY");
    process.exitCode = 2;
    return;
  }
  const discovered = discoverAll();
  const installed = Object.values(discovered).filter((item) => item.installed);
  if (installed.length === 0) {
    console.log("No registered CLI is installed; smoke skipped.");
    return;
  }
  const results = [];
  for (const item of installed) results.push(await runVersion(item.command));
  for (const result of results) {
    console.log(JSON.stringify(result));
    if (result.timeout || result.exitCode !== 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
