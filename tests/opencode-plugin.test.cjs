const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHookServer } = require("../src/main/hook-server.cjs");
const { setTimeout: delay } = require("node:timers/promises");
const http = require("node:http");
const pluginModule = import(pathToFileURL(path.join(__dirname, "..", "hooks", "opencode", "termbeacon.js")).href);

test("opencode plugin maps session and tool events to hook statuses", { timeout: 10000 }, async (t) => {
  const events = [];
  let resolveEvents;
  const receivedEvents = new Promise((resolve) => { resolveEvents = resolve; });
  const server = createHookServer({ onEvent: (event) => {
    events.push(event);
    if (events.length === 4) resolveEvents();
  } });
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
  t.after(() => {
    closed = true;
    if (wake) { const resolve = wake; wake = undefined; resolve(); }
    cleanup();
  });
  push({ type: "session.status", data: { sessionId: "opencode-session-1", status: { type: "busy" } } });
  push({ type: "session.idle", data: {} });
  push({ type: "session.execution.failed", data: {} });
  push({ type: "permission.asked", data: { status: "pending" } });
  await receivedEvents;

  assert.deepEqual(events.map((event) => [event.event, event.status]), [
    ["session.status", "running"],
    ["session.idle", "completed"],
    ["session.execution.failed", "failed"],
    ["permission.asked", "waiting"],
  ]);
  assert.ok(events.every((event) => event.terminalId === "opencode-1"));
  assert.equal(events[0].sessionId, "opencode-session-1");
});

async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for plugin state");
    await delay(10);
  }
}

async function harness(t, overrides = {}) {
  const received = [];
  const server = createHookServer({ onEvent: (event) => received.push(event) });
  const port = await server.start();
  const keys = ["TERMBEACON_HOOK_PORT", "TERMBEACON_HOOK_TOKEN", "TERMBEACON_TERMINAL_ID"];
  const previous = keys.map((key) => process.env[key]);
  [String(port), server.token, "test-terminal"].forEach((value, index) => { process.env[keys[index]] = value; });
  t.after(() => {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    return server.close();
  });
  const queue = [];
  let wake;
  let subscriptions = 0;
  const callbacks = {};
  const ctx = {
    event: { async *subscribe({ signal }) {
      subscriptions += 1;
      const abort = () => wake?.();
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (!signal.aborted) {
          if (!queue.length) await new Promise((resolve) => { wake = resolve; });
          if (signal.aborted) break;
          const event = queue.shift();
          if (event?.disconnect) throw new Error("event stream disconnected");
          if (event) yield event;
        }
      } finally { signal.removeEventListener("abort", abort); }
    } },
    session: {
      async get({ sessionID }) { return { id: sessionID, parentID: sessionID === "child" ? "main" : undefined }; },
      async hook(name, callback) { callbacks[name] = callback; return { dispose() {} }; },
      ...overrides,
    },
    tool: { async hook() { return { dispose() {} }; } },
  };
  const { default: plugin } = await pluginModule;
  const cleanup = await plugin.setup(ctx);
  t.after(cleanup);
  return {
    received, callbacks, ctx, cleanup,
    push(event) { queue.push(event); wake?.(); wake = undefined; },
    get subscriptions() { return subscriptions; },
  };
}

test("child lifecycle events do not complete the root, but child permission requests are visible", async (t) => {
  const h = await harness(t);
  h.push({ type: "session.status", data: { sessionID: "main", status: "busy" } });
  h.push({ type: "session.idle", data: { sessionID: "child" } });
  h.push({ type: "session.execution.failed", data: { sessionID: "child" } });
  h.push({ type: "permission.asked", data: { sessionID: "child" } });
  h.push({ type: "permission.replied", data: { sessionID: "child" } });
  h.push({ type: "session.idle", data: { sessionID: "main" } });
  await until(() => h.received.length === 4);
  assert.deepEqual(h.received.map((event) => event.status), ["running", "waiting", "running", "completed"]);
  assert.ok(h.received.every((event) => event.sessionId === "main"));
});

test("event subscription reconnect repairs a missed completion from a session snapshot", async (t) => {
  let snapshot = false;
  const h = await harness(t, {
    async get({ sessionID }) { return { id: sessionID, outcome: snapshot ? "succeeded" : undefined }; },
    async active() { return {}; },
  });
  h.push({ type: "session.status", data: { sessionID: "main", status: "busy" } });
  await until(() => h.received.length === 1);
  snapshot = true;
  h.push({ disconnect: true });
  await until(() => h.subscriptions >= 2 && h.received.some((event) => event.status === "completed"));
  assert.equal(h.received.at(-1).event, "session.snapshot");
  assert.equal(h.received.at(-1).sessionId, "main");
});

test("a prompt selects a new root without accepting unrelated background completions", async (t) => {
  const h = await harness(t);
  h.callbacks.prompt({ sessionID: "main" });
  await until(() => h.received.length === 1);
  h.push({ type: "session.idle", data: { sessionID: "unrelated" } });
  h.callbacks.prompt({ sessionID: "second" });
  h.push({ type: "session.idle", data: { sessionID: "second" } });
  await until(() => h.received.some((event) => event.status === "completed"));
  assert.deepEqual(h.received.map((event) => [event.sessionId, event.status]), [
    ["main", "running"], ["second", "running"], ["second", "completed"],
  ]);
});

test("report delivery stays ordered while the bridge is slow", async (t) => {
  const requests = [];
  let concurrent = 0;
  let peak = 0;
  const server = http.createServer(async (request, response) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    let body = "";
    for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    await delay(40);
    concurrent -= 1;
    response.writeHead(204); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { createReporter } = await pluginModule;
  const reporter = createReporter({ port: server.address().port, token: "test", terminalId: "t1" }, controller.signal);
  reporter.report("session.status", "running", "main");
  reporter.report("permission.asked", "waiting", "main");
  reporter.report("session.idle", "completed", "main");
  await until(() => requests.length === 3);
  assert.equal(peak, 1);
  assert.deepEqual(requests.map((event) => event.status), ["running", "waiting", "completed"]);
});

test("bridge outage retries the latest state and cleanup cancels retries", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    response.writeHead(requests.length <= 2 ? 503 : 204); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { createReporter } = await pluginModule;
  const reporter = createReporter({ port: server.address().port, token: "test", terminalId: "t1" }, controller.signal);
  reporter.report("session.status", "running", "main");
  await until(() => requests.length === 1);
  reporter.report("session.idle", "completed", "main");
  await until(() => requests.length >= 3);
  assert.equal(requests.at(-1).status, "completed");
  assert.equal(requests[1].eventId, requests[2].eventId);
  controller.abort();
  reporter.report("session.status", "running", "main");
  const count = requests.length;
  await delay(100);
  assert.equal(requests.length, count);
});

test("initial idle events do not mark an unused CLI as completed", async (t) => {
  const h = await harness(t);
  h.push({ type: "session.idle", data: { sessionID: "old" } });
  h.push({ type: "session.status", data: { sessionID: "main", status: "busy" } });
  await until(() => h.received.length === 1);
  assert.equal(h.received[0].status, "running");
  assert.equal(h.received[0].sessionId, "main");
});

test("a slow poll cannot reverse a newer completion event", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  let resolveSnapshot;
  const h = await harness(t, {
    async get({ sessionID }) {
      reads += 1;
      if (reads === 1) return { id: sessionID };
      return new Promise((resolve) => { resolveSnapshot = resolve; });
    },
    async active() { return { main: {} }; },
  });
  h.push({ type: "session.status", data: { sessionID: "main", status: "busy" } });
  await until(() => h.received.length === 1);
  t.mock.timers.tick(5000);
  await until(() => reads === 2);
  h.push({ type: "session.idle", data: { sessionID: "main" } });
  await until(() => h.received.length === 2);
  resolveSnapshot({ id: "main" });
  await delay(30);
  assert.equal(h.received.length, 2);
  assert.equal(h.received.at(-1).status, "completed");
});

test("active session membership cannot relight a completed turn", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t, {
    async get({ sessionID }) { return { id: sessionID, outcome: "succeeded" }; },
    // OpenCode keeps the interactive session in `active` while it waits for
    // the next prompt, even after the current turn has completed.
    async active() { return { main: { type: "idle" } }; },
  });
  h.callbacks.prompt({ sessionID: "main" });
  await until(() => h.received.length === 1);
  h.push({ type: "session.execution.succeeded", data: { sessionID: "main" } });
  await until(() => h.received.length === 2);
  assert.equal(h.received.at(-1).status, "completed");

  t.mock.timers.tick(5000);
  await delay(30);
  assert.equal(h.received.length, 2, "a stale active snapshot must not restore Working");

  h.callbacks.prompt({ sessionID: "main" });
  await until(() => h.received.length === 3);
  assert.equal(h.received.at(-1).status, "running", "a new prompt must start a new turn");
});

test("an idle projection from an earlier turn cannot complete a newly submitted prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  const h = await harness(t, {
    async get({ sessionID }) { reads += 1; return { id: sessionID, outcome: "succeeded", time: { idle: 1 } }; },
    async active() { return {}; },
  });
  h.callbacks.prompt({ sessionID: "main" });
  await until(() => h.received.length === 1);
  t.mock.timers.tick(5000);
  await until(() => reads === 2);
  await delay(30);
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0].status, "running");
});

test("native v2 API data envelopes preserve active turns and reconcile missed completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let active = true;
  let reads = 0;
  const h = await harness(t, {
    async get({ sessionID }) { reads++; return { data: { id: sessionID, outcome: "succeeded", time: { idle: Date.now() + 1000 } } }; },
    async active() { return { data: active ? { main: { type: "running" } } : {} }; },
  });
  h.callbacks.prompt({ sessionID: "main" });
  await until(() => h.received.length === 1);
  t.mock.timers.tick(5000);
  await until(() => reads >= 2);
  await delay(30);
  assert.equal(h.received.length, 1);
  active = false;
  t.mock.timers.tick(5000);
  await until(() => h.received.length === 2);
  assert.equal(h.received[1].status, "completed");
});

test("child metadata in native API data envelopes cannot complete the root session", async (t) => {
  const h = await harness(t, { async get({ sessionID }) { return { data: { id: sessionID, ...(sessionID === "child" ? { parentID: "main" } : {}) } }; } });
  h.callbacks.prompt({ sessionID: "main" });
  await until(() => h.received.length === 1);
  h.push({ type: "session.execution.succeeded", data: { sessionID: "child" } });
  h.push({ type: "permission.asked", data: { sessionID: "child" } });
  await until(() => h.received.length === 2);
  assert.equal(h.received[1].status, "waiting");
  assert.equal(h.received[1].sessionId, "main");
});
