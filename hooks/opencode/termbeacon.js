/**
 * TermBeacon plugin for opencode.
 *
 * opencode plugins are loaded from ~/.config/opencode/plugin/ or a project's
 * .opencode/plugin/ directory. TermBeacon injects TERMBEACON_HOOK_PORT,
 * TERMBEACON_HOOK_TOKEN and TERMBEACON_TERMINAL_ID into the PTY environment, so
 * this plugin can report session state without any global configuration.
 *
 * Install: copy this file to ~/.config/opencode/plugin/termbeacon.js (or
 * .opencode/plugin/termbeacon.js in a project), then restart opencode.
 * Outside TermBeacon the environment is absent and the plugin is a no-op.
 */

const STATUS = {
  busy: "running",
  running: "running",
  retry: "running",
  idle: "completed",
  completed: "completed",
  error: "failed",
  failed: "failed",
};

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
  const type = value.type || value.status || value.state;
  return typeof type === "string" ? STATUS[type.toLowerCase()] : undefined;
}

async function post(connection, event, status) {
  if (!status) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`http://127.0.0.1:${connection.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-termbeacon-token": connection.token },
      body: JSON.stringify({ terminalId: connection.terminalId, event, status }),
      signal: controller.signal,
    });
  } catch {
    // The app may have closed; never let telemetry break the CLI.
  } finally {
    clearTimeout(timer);
  }
}

export const TermBeacon = async () => {
  const connection = bridge();
  if (!connection) return {};
  let last = "";
  let lastAt = 0;

  function report(event, status) {
    const now = Date.now();
    if (status === last && now - lastAt < 1000) return;
    last = status;
    lastAt = now;
    void post(connection, event, status);
  }

  return {
    event: async ({ event }) => {
      if (!event || typeof event.type !== "string") return;
      const properties = event.properties || {};
      if (event.type === "session.status") {
        report(event.type, statusOf(properties.status));
        return;
      }
      if (event.type === "session.idle") {
        report(event.type, "completed");
        return;
      }
      if (event.type === "session.error") {
        report(event.type, "failed");
        return;
      }
      if (event.type === "tool.execute.before" || event.type === "tool.execute.after") {
        report(event.type, "running");
        return;
      }
      if (event.type === "permission.asked" || event.type === "permission.updated") {
        const state = properties.status || properties.state;
        if (!state || state === "pending" || state === "ask") report(event.type, "waiting");
      }
    },
  };
};

export default TermBeacon;
