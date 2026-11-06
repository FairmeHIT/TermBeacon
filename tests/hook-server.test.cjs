const test = require("node:test");
const assert = require("node:assert/strict");
const { createHookServer } = require("../src/main/hook-server.cjs");

async function withServer(t) {
  const events = [];
  const server = createHookServer({ onEvent: (event) => events.push(event) });
  const port = await server.start();
  t.after(() => server.close());
  return { server, port, events };
}

function post(port, body, token) {
  return fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-termbeacon-token": token },
    body: JSON.stringify(body),
  });
}

test("hook server forwards a valid event", async (t) => {
  const { server, port, events } = await withServer(t);
  const response = await post(port, { terminalId: "t1", event: "session.idle", status: "completed" }, server.token);
  assert.equal(response.status, 204);
  assert.equal(events.length, 1);
  assert.equal(events[0].terminalId, "t1");
  assert.equal(events[0].event, "session.idle");
  assert.equal(events[0].status, "completed");
});

test("hook server forwards an optional bounded session id", async (t) => {
  const { server, port, events } = await withServer(t);
  const response = await post(port, { terminalId: "t1", event: "session.status", status: "running", sessionId: "session-1" }, server.token);
  assert.equal(response.status, 204);
  assert.equal(events[0].sessionId, "session-1");
  const tooLong = await post(port, { terminalId: "t1", event: "session.status", status: "running", sessionId: "x".repeat(257) }, server.token);
  assert.equal(tooLong.status, 400);
});

test("hook server rejects a missing or wrong token", async (t) => {
  const { server, port, events } = await withServer(t);
  const wrong = await post(port, { terminalId: "t1", event: "x", status: "running" }, "wrong");
  const missing = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalId: "t1", event: "x", status: "running" }),
  });
  assert.equal(wrong.status, 403);
  assert.equal(missing.status, 403);
  assert.equal(events.length, 0);
});

test("hook server rejects malformed payloads", async (t) => {
  const { server, port, events } = await withServer(t);
  const badStatus = await post(port, { terminalId: "t1", event: "x", status: "unknown" }, server.token);
  const missingTerminal = await post(port, { event: "x", status: "running" }, server.token);
  const notJson = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-termbeacon-token": server.token },
    body: "not json",
  });
  assert.equal(badStatus.status, 400);
  assert.equal(missingTerminal.status, 400);
  assert.equal(notJson.status, 400);
  assert.equal(events.length, 0);
});

test("hook server only accepts POST /hook", async (t) => {
  const { server, port } = await withServer(t);
  for (const path of ["/other", "/hook-extra"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-termbeacon-token": server.token },
      body: JSON.stringify({ terminalId: "t1", event: "x", status: "running" }),
    });
    assert.equal(response.status, 404);
  }
});
