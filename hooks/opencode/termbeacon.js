/**
 * TermBeacon plugin for opencode.
 *
 * V2 plugin API: the default export is a definition with an `id` and a
 * `setup(ctx)` function. V1 plugins (a function returning an `event` hook)
 * no longer run in opencode V2.
 *
 * opencode loads plugins from ~/.config/opencode/plugin/ (global) or
 * .opencode/plugin/ (project). TermBeacon injects TERMBEACON_HOOK_PORT,
 * TERMBEACON_HOOK_TOKEN and TERMBEACON_TERMINAL_ID into the CLI environment.
 * Outside TermBeacon the environment is absent and the plugin is a no-op.
 *
 * Install: copy this file to ~/.config/opencode/plugin/termbeacon.js, then
 * restart opencode (or run `opencode reload`).
 */

const STATUS = {
  busy: "running",
  running: "running",
  retry: "running",
  idle: "completed",
  completed: "completed",
  succeeded: "completed",
  interrupted: "completed",
  cancelled: "completed",
  error: "failed",
  failed: "failed",
};

/** Events worth forwarding; anything else is ignored. */
const EVENT_TYPES = [
  "session.status",
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
];

function bridge() {
  const port = process.env.TERMBEACON_HOOK_PORT;
  const token = process.env.TERMBEACON_HOOK_TOKEN;
  const terminalId = process.env.TERMBEACON_TERMINAL_ID;
  if (!port || !token || !terminalId) return null;
  return { port, token, terminalId };
}

function statusOf(value) {
  if (!value) return undefined;
  if (typeof value === "string") return STATUS[value.toLowerCase()];
  const type = value.type || value.status || value.state || value.outcome;
  return typeof type === "string" ? STATUS[type.toLowerCase()] : undefined;
}

function sessionIdOf(event) {
  const data = event && event.data;
  const candidates = [
    data?.sessionId, data?.session_id, data?.sessionID,
    data?.session?.id, data?.session?.sessionId,
    event?.sessionId, event?.session_id,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return value && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, 256) : undefined;
}

async function post(connection, event, status, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`http://127.0.0.1:${connection.port}/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-termbeacon-token": connection.token,
      },
      body: JSON.stringify({
        terminalId: connection.terminalId,
        event,
        status,
        ...(sessionId ? { sessionId } : {}),
      }),
      signal: controller.signal,
    });
  } catch {
    // The app may have closed; never let telemetry break the CLI.
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: "termbeacon",
  async setup(ctx) {
    const connection = bridge();
    // Not launched by TermBeacon: stay inert.
    if (!connection) return;

    let last = "";
    let lastSessionId = "";
    let lastAt = 0;

    function report(event, status, sessionId) {
      if (!status) return;
      const now = Date.now();
      // The same status within one second is a duplicate (multiple plugin
      // instances, or several events for one transition).
      if (status === last && sessionId === lastSessionId && now - lastAt < 1000) return;
      last = status;
      lastSessionId = sessionId || "";
      lastAt = now;
      void post(connection, event, status, sessionId);
    }

    const controller = new AbortController();
    const registrations = [];

    // Primary signal: the public event stream. The envelope is
    // { id, created, type, location, data }.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: EVENT_TYPES,
          signal: controller.signal,
        })) {
          const type = event && event.type;
          const data = (event && event.data) || {};
          const sessionId = sessionIdOf(event);
          if (type === "session.status") {
            report(type, statusOf(data.status), sessionId);
          } else if (type === "session.idle") {
            report(type, statusOf(data.outcome) || "completed", sessionId);
          } else if (type === "session.execution.started") {
            report(type, "running", sessionId);
          } else if (
            type === "session.execution.succeeded" ||
            type === "session.execution.interrupted"
          ) {
            report(type, "completed", sessionId);
          } else if (type === "session.execution.failed") {
            report(type, "failed", sessionId);
          } else if (type === "permission.asked") {
            report(type, "waiting", sessionId);
          } else if (type === "permission.replied") {
            report(type, "running", sessionId);
          }
        }
      } catch {
        // Aborted during cleanup, or the stream overflowed.
      }
    })();

    // Fallback signals that do not depend on the public stream: a submitted
    // prompt or a tool call always means the session is working.
    try {
      registrations.push(
        await ctx.session.hook("prompt", () => report("session.prompt", "running")),
      );
    } catch {
      // Older builds may not expose this hook.
    }
    try {
      registrations.push(
        await ctx.tool.hook("execute.before", () => report("tool.execute.before", "running")),
      );
    } catch {
      // Ignore.
    }

    return () => {
      controller.abort();
      for (const registration of registrations) {
        try {
          void registration.dispose();
        } catch {
          // Ignore.
        }
      }
    };
  },
};
