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
  const { TermBeacon } = await import(moduleUrl);
  const hooks = await TermBeacon();
  assert.equal(typeof hooks.event, "function");

  await hooks.event({ event: { type: "session.status", properties: { status: { type: "busy" } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hooks.event({ event: { type: "session.error", properties: {} } });
  await hooks.event({ event: { type: "permission.asked", properties: { status: "pending" } } });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(events.map((event) => [event.event, event.status]), [
    ["session.status", "running"],
    ["session.idle", "completed"],
    ["session.error", "failed"],
    ["permission.asked", "waiting"],
  ]);
  assert.ok(events.every((event) => event.terminalId === "opencode-1"));
});
