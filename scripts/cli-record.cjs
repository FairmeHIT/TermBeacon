/**
 * Interactive PTY recorder for TermBeacon CLI calibration.
 *
 * Usage:
 *   npm run record:cli -- --cli claude
 *   npm run record:cli -- --cli codex --name codex-basic
 *   npm run record:cli -- --command "node .\\fake-cli.js" --cli generic
 *
 * The recorder spawns the CLI through node-pty/ConPTY, forwards your keyboard
 * input to it, and writes every output chunk with a relative timestamp to a
 * JSONL capture. Exit the CLI normally (or press Ctrl+D / type exit) to stop
 * recording. Captures may contain prompts, paths or tokens: review before
 * committing them. They are written outside tests/fixtures by default and
 * `captures/` is gitignored.
 */
const fs = require("node:fs");
const path = require("node:path");
const { isWindows, defaultShell } = require("../src/main/platform.cjs");
const { discoverAll } = require("../src/main/cli-discovery.cjs");
const { stripInputSequences } = require("../src/main/detection-engine.cjs");

// Mouse reports, focus events and Kitty key-release events are useful to the
// CLI but pure noise in a capture. Keep only text, Enter and Ctrl+C; forward
// everything to the child regardless.
function isMeaningfulInput(text) {
  if (text.includes("\u0003") || text.includes("\r") || text.includes("\n")) return true;
  return /[^\u0000-\u001f\u007f]/.test(stripInputSequences(text));
}

function parseArgs(argv) {
  const args = { cols: 120, rows: 32, maxMinutes: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    index += 1;
    if (key === "cols" || key === "rows" || key === "max-minutes" || key === "task-delay") {
      const mapped = key === "max-minutes" ? "maxMinutes" : key === "task-delay" ? "taskDelay" : key;
      args[mapped] = Number(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function usage() {
  console.error(`TermBeacon CLI recorder

  --cli <opencode|codex|claude|generic>  Agent id (used for metadata and default command)
  --command <string>                     Override the launched command
  --name <label>                         Capture label (used in the file name)
  --out <path>                           Output JSONL path (default: captures/<cli>-<stamp>.jsonl)
  --cols <n> --rows <n>                  PTY size (default 120x32)
  --max-minutes <n>                      Safety timeout (default 15)
  --task <string>                        Auto-submit this task after --task-delay
  --task-delay <ms>                      Auto-task delay (default 12000)

Exit the CLI normally to finish the capture.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (!args.cli && !args.command) { usage(); process.exit(1); }

const agent = String(args.cli || "generic");
const discovered = discoverAll();
const info = discovered[agent];
const command = String(args.command || info?.command || agent);
const label = String(args.name || "capture").replace(/[^a-zA-Z0-9._-]+/g, "-");
const outPath = path.resolve(String(args.out || path.join("captures", `${agent}-${label}-${stamp()}.jsonl`)));
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const stream = fs.createWriteStream(outPath, { flags: "a" });
const startedAt = Date.now();
let closed = false;

function record(entry) {
  if (closed) return;
  stream.write(`${JSON.stringify(entry)}\n`);
}

record({
  kind: "meta",
  schemaVersion: 1,
  agent,
  name: label,
  command,
  executable: info?.executable,
  version: info?.version,
  platform: process.platform,
  cols: args.cols,
  rows: args.rows,
  startedAt: new Date().toISOString(),
});

const shell = isWindows ? (process.env.ComSpec || "cmd.exe") : defaultShell();
const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

let child;
let pty;
try {
  pty = require("node-pty");
} catch (error) {
  console.error("[record] node-pty is unavailable in this environment; run the recorder on the Windows host.");
  console.error(`[record] ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  process.exit(1);
}
try {
  child = pty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: args.cols,
    rows: args.rows,
    cwd: process.cwd(),
    env: process.env,
    ...(isWindows ? { useConpty: true } : {}),
  });
} catch (error) {
  record({ kind: "error", at: Date.now() - startedAt, message: error instanceof Error ? error.message : String(error) });
  stream.end(() => {
    console.error("[record] failed to start:", error);
    process.exit(1);
  });
  return;
}

console.error(`[record] agent: ${agent}${info?.version ? ` (${info.version})` : ""}`);
console.error(`[record] command: ${command}`);
console.error(`[record] output: ${outPath}`);
console.error("[record] interact normally; exit the CLI to save the capture.");

const task = typeof args.task === "string" ? args.task : undefined;
const taskDelay = Number.isFinite(args.taskDelay) ? Math.max(1000, args.taskDelay) : 12000;
let taskTimer = null;
if (task) {
  console.error(`[record] auto task in ${taskDelay}ms: ${task}`);
  taskTimer = setTimeout(() => {
    const data = `${task}\r`;
    record({ kind: "input", at: Date.now() - startedAt, data, source: "task" });
    try { child.write(data); } catch { /* child may have exited */ }
  }, taskDelay);
}

const maxTimer = setTimeout(() => {
  console.error(`[record] max duration (${args.maxMinutes} min) reached, stopping`);
  try { child.kill(); } catch { /* already gone */ }
}, Math.max(1, args.maxMinutes) * 60_000);

let rawMode = false;
try {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    rawMode = true;
  }
} catch { /* non-tty stdin: pipe input instead */ }

process.stdin.resume();
process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  if (isMeaningfulInput(text)) record({ kind: "input", at: Date.now() - startedAt, data: text });
  try { child.write(text); } catch { /* child may have exited */ }
});

function finish(exitCode, signal) {
  if (closed) return;
  record({ kind: "exit", at: Date.now() - startedAt, exitCode, signal });
  closed = true;
  clearTimeout(maxTimer);
  if (taskTimer) clearTimeout(taskTimer);
  if (rawMode) {
    try { process.stdin.setRawMode(false); } catch { /* terminal already gone */ }
  }
  stream.end(() => {
    console.error(`[record] saved: ${outPath}`);
    console.error("[record] review the capture for secrets before turning it into a fixture.");
    process.exit(0);
  });
}

child.onData((data) => {
  process.stdout.write(data);
  record({ kind: "output", at: Date.now() - startedAt, data });
});

child.onExit(({ exitCode, signal }) => finish(exitCode, signal));

process.on("SIGINT", () => {
  try { child.kill(); } catch { /* already gone */ }
});
process.on("SIGTERM", () => {
  try { child.kill(); } catch { /* already gone */ }
});
