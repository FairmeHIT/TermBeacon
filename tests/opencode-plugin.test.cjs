const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHookServer } = require("../src/main/hook-server.cjs");

test("opencode plugin maps session and tool events to hook statuses", async (t) => {
  const events = [];
  const server = createHookServer({ onEvent: (event) => events.push(event) });
  const port = await server.start();
  t.after(() => server.close());

  process.env.TERMBEACON_HOOK_PORT = String(port);
  process.env.TERMBEACON_HOOK_TOKEN = server.token;
  process.env.TERMBEACON_TERMINAL_ID = "opencode-1";
  t.after(() => {
    delete process.env.TERMBEACON_HOOK_PORT;
    delete process.env.TERMBEACON_HOOK_TOKEN;
    delete process.env.TERMBEACON_TERMINAL_ID;
  });

  const moduleUrl = pathToFileURL(path.join(__dirname, "..", "hooks", "opencode", "termbeacon.js")).href;
  const { default: plugin } = await import(moduleUrl);
  assert.equal(plugin.id, "termbeacon");

  const queue = [];
  let wake;
  let closed = false;
  const subscribe = async function* () {
    while (!closed) {
      if (!queue.length) await new Promise((resolve) => { wake = resolve; });
      if (closed) break;
      yield queue.shift();
    }
  };
  const push = (event) => {
    queue.push(event);
    if (wake) { const resolve = wake; wake = undefined; resolve(); }
  };
  const ctx = {
    event: { subscribe },
    session: { hook: async () => ({ dispose() {} }) },
    tool: { hook: async () => ({ dispose() {} }) },
  };
  const cleanup = await plugin.setup(ctx);
  push({ type: "session.status", data: { sessionId: "opencode-session-1", status: { type: "busy" } } });
  push({ type: "session.idle", data: {} });
  push({ type: "session.execution.failed", data: {} });
  push({ type: "permission.asked", data: { status: "pending" } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  closed = true;
  if (wake) { const resolve = wake; wake = undefined; resolve(); }
  cleanup();

  assert.deepEqual(events.map((event) => [event.event, event.status]), [
    ["session.status", "running"],
    ["session.idle", "completed"],
    ["session.execution.failed", "failed"],
    ["permission.asked", "waiting"],
  ]);
  assert.ok(events.every((event) => event.terminalId === "opencode-1"));
  assert.equal(events[0].sessionId, "opencode-session-1");
});
