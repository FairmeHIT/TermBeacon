/**
 * Generic TermBeacon hook client.
 *
 * TermBeacon injects TERMBEACON_HOOK_PORT, TERMBEACON_HOOK_TOKEN and
 * TERMBEACON_TERMINAL_ID into every PTY it creates. A CLI hook (or a wrapper
 * script) can call this file to report task state:
 *
 *   node scripts/termbeacon-hook.cjs --status completed --event Stop
 *   node scripts/termbeacon-hook.cjs completed Stop
 *   echo '{"hook_event_name":"Stop"}' | node scripts/termbeacon-hook.cjs
 *
 * When run as a Claude Code hook, Claude passes a JSON payload on stdin. The
 * script maps common Claude event names to TermBeacon statuses and ignores
 * everything silently when it is not running inside TermBeacon.
 */
const fs = require("node:fs");

const STATUSES = new Set(["started", "running", "waiting", "completed", "failed"]);

const EVENT_STATUS = {
  SessionStart: "started",
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  PreCompact: "running",
  Notification: "waiting",
  Stop: "completed",
  SubagentStop: "completed",
  SessionEnd: "completed",
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      args[token.slice(2)] = argv[index + 1];
      index += 1;
    } else if (!args.status) {
      args.status = token;
    } else if (!args.event) {
      args.event = token;
    }
  }
  return args;
}

function readStdin() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function sessionIdFromInput(input) {
  const value = input?.session_id ?? input?.sessionId ?? input?.sessionID;
  if (typeof value === "string" && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) return value.trim();
  return undefined;
}

async function post(payload) {
  const port = process.env.TERMBEACON_HOOK_PORT;
  const token = process.env.TERMBEACON_HOOK_TOKEN;
  const terminalId = process.env.TERMBEACON_TERMINAL_ID;
  if (!port || !token || !terminalId) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-termbeacon-token": token },
      body: JSON.stringify({ terminalId, ...payload }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = readStdin();
  const event = String(args.event || input.hook_event_name || input.event || "hook");
  const status = String(args.status || EVENT_STATUS[event] || "running");
  if (!STATUSES.has(status)) {
    console.error(`[termbeacon-hook] unknown status: ${status}`);
    process.exitCode = 1;
    return;
  }
  const sessionId = args.session_id || args.sessionId || sessionIdFromInput(input);
  const ok = await post({ event, status, ...(sessionId ? { sessionId: String(sessionId).slice(0, 256) } : {}) });
  if (!ok && process.env.TERMBEACON_HOOK_PORT) {
    console.error("[termbeacon-hook] could not reach the TermBeacon hook bridge");
  }
}

main().catch(() => {
  // Hooks must never break the CLI. Exit quietly.
});
