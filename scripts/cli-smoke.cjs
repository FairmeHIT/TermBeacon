const pty = require("node-pty");
const { discoverAll, getLaunchSpec } = require("../src/main/cli-discovery.cjs");
const { isWindows } = require("../src/main/platform.cjs");

const TIMEOUT_MS = 8000;

function stripTerminalControls(value) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

async function runCommand(item, argument) {
  const shell = isWindows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const spec = await getLaunchSpec({ id: item.id, shell, args: [argument] });
  return new Promise((resolve) => {
    const command = item.command;
    let child;
    try {
      if (isWindows) {
        // node-pty accepts a raw Windows command tail. An argv array would
        // apply C runtime escaping to quotes that cmd.exe must parse itself.
        child = pty.spawn(shell, `/d /s /c "${spec.command}"`, {
          name: "xterm-256color",
          cols: 120,
          rows: 32,
          cwd: process.cwd(),
          env: process.env,
          useConpty: true,
        });
      } else {
        child = pty.spawn(shell, ["-c", spec.command], {
          name: "xterm-256color",
          cols: 120,
          rows: 32,
          cwd: process.cwd(),
          env: process.env,
        });
      }
    } catch (error) {
      resolve({ command, executable: item.executable, argument, spawnError: error?.message || String(error) });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, executable: item.executable, argument, pid: child.pid, output: stripTerminalControls(output).trim().slice(0, 400), ...result });
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
  const discovered = await discoverAll();
  const installed = Object.values(discovered).filter((item) => item.installed);
  if (installed.length === 0) {
    console.log("No registered CLI is installed; smoke skipped.");
    return;
  }
  const argument = process.argv[2] === "--help" ? "--help" : "--version";
  const results = [];
  for (const item of installed) results.push(await runCommand(item, argument));
  let failed = false;
  for (const result of results) {
    console.log(JSON.stringify(result));
    if (result.spawnError || result.timeout || result.exitCode !== 0 || !result.output) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
