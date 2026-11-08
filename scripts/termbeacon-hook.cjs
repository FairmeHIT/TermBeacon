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
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const fs = require("node:fs");

const STATUSES = new Set(["started", "running", "waiting", "completed", "failed"]);
const MAX_STDIN_BYTES = 128 * 1024;

const EVENT_STATUS = {
  SessionStart: "started",
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  PreCompact: "running",
  PermissionRequest: "waiting",
  Stop: "completed",
  SessionEnd: "completed",
};

function statusForEvent(event, input = {}) {
  if (event === "Notification") {
    // Authentication and other informational notifications need no action.
    const type = input.notification_type;
    if (!type || ["permission_prompt", "idle_prompt", "elicitation_dialog"].includes(type)) return "waiting";
    return undefined;
  }
  return EVENT_STATUS[event];
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--hook") continue;
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

async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return {};
  try {
    const chunks = [];
    let total = 0;
    if (stream === process.stdin && process.versions.electron && typeof stream.fd !== "number") {
      // Electron on Windows exposes an empty stdin stream even when fd 0 is
      // a valid inherited pipe. Read the bounded hook payload from that fd.
      const buffer = Buffer.allocUnsafe(16 * 1024);
      while (true) {
        const count = fs.readSync(0, buffer, 0, buffer.length, null);
        if (!count) break;
        total += count;
        if (total > MAX_STDIN_BYTES) return null;
        chunks.push(Buffer.from(buffer.subarray(0, count)));
      }
    } else {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_STDIN_BYTES) return null;
        chunks.push(buffer);
      }
    }
    const raw = Buffer.concat(chunks, total).toString("utf8").trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sessionIdFromInput(input) {
  const value = input?.session_id ?? input?.sessionId ?? input?.sessionID;
  if (typeof value === "string" && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) return value.trim();
  return undefined;
}

async function post(payload, { env = process.env, fetchImpl = fetch, sleep = delay } = {}) {
  const port = env.TERMBEACON_HOOK_PORT;
  const token = env.TERMBEACON_HOOK_TOKEN;
  const terminalId = env.TERMBEACON_TERMINAL_ID;
  if (!port || !token || !terminalId) return false;
  // Keep the same id/time across retries: a lost HTTP response must not apply
  // completion twice, or deliver an old transition after a newer event.
  const body = JSON.stringify({ terminalId, eventId: randomUUID(), occurredAt: Date.now(), ...payload });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(attempt === 1 ? 100 : 250);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-termbeacon-token": token },
        body,
        signal: controller.signal,
      });
      if (response.ok) return true;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) return false;
    } catch {
      // Retry transient connection failures within the hook's time budget.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function runHook(argv = process.argv.slice(2)) {
  if (!process.env.TERMBEACON_HOOK_PORT || !process.env.TERMBEACON_HOOK_TOKEN || !process.env.TERMBEACON_TERMINAL_ID) return;
  const occurredAt = Date.now();
  const args = parseArgs(argv);
  const input = await readStdin();
  if (!input) return;
  const event = String(args.event || input.hook_event_name || input.event || "hook");
  // A subagent/team task ending says nothing about the main turn ending.
  if (event === "SubagentStop" || event === "TaskCompleted") return;
  const status = args.status || statusForEvent(event, input);
  if (!status) return;
  if (!STATUSES.has(status)) {
    console.error(`[termbeacon-hook] unknown status: ${status}`);
    process.exitCode = 1;
    return;
  }
  const sessionId = args.session_id || args.sessionId || sessionIdFromInput(input);
  const ok = await post({ event, status, occurredAt, ...(sessionId ? { sessionId: String(sessionId).slice(0, 256) } : {}) });
  if (!ok && process.env.TERMBEACON_HOOK_PORT) {
    console.error("[termbeacon-hook] could not reach the TermBeacon hook bridge");
  }
}

if (require.main === module) {
  runHook().catch(() => {
    // Hooks must never break the CLI. Exit quietly.
  });
}

module.exports = { runHook, parseArgs, statusForEvent, readStdin, post };
