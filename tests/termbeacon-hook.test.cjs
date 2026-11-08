const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createHookServer } = require("../src/main/hook-server.cjs");
const { post, statusForEvent, readStdin } = require("../scripts/termbeacon-hook.cjs");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const vm = require("node:vm");

// The hook client reads stdin synchronously whenever it is not a TTY, so the
// child must observe EOF or it blocks forever. execFile keeps the stdin pipe
// open by default, hence the explicit end() call.
function run(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
}
const script = path.join(__dirname, "..", "scripts", "termbeacon-hook.cjs");

test("hook client forwards a status from the PTY environment", async (t) => {
  const events = [];
  const server = createHookServer({ onEvent: (event) => events.push(event) });
  const port = await server.start();
  t.after(() => server.close());

  await run(process.execPath, [script, "completed", "Stop"], {
    env: {
      ...process.env,
      TERMBEACON_HOOK_PORT: String(port),
      TERMBEACON_HOOK_TOKEN: server.token,
      TERMBEACON_TERMINAL_ID: "terminal-1",
    },
  });

  assert.equal(events.length, 1);
  assert.deepEqual(
    { terminalId: events[0].terminalId, event: events[0].event, status: events[0].status },
    { terminalId: "terminal-1", event: "Stop", status: "completed" },
  );
});

test("hook client forwards Claude session_id from stdin", async (t) => {
  const events = [];
  const server = createHookServer({ onEvent: (event) => events.push(event) });
  const port = await server.start();
  t.after(() => server.close());
  const child = execFile(process.execPath, [script, "running", "SessionStart"], {
    env: { ...process.env, TERMBEACON_HOOK_PORT: String(port), TERMBEACON_HOOK_TOKEN: server.token, TERMBEACON_TERMINAL_ID: "terminal-2" },
  });
  child.stdin.end(JSON.stringify({ session_id: "claude-session-1" }));
  await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  assert.equal(events[0].sessionId, "claude-session-1");
});

test("hook client is a no-op outside TermBeacon", async () => {
  const result = await run(process.execPath, [script, "completed", "Stop"], {
    env: { ...process.env, TERMBEACON_HOOK_PORT: "", TERMBEACON_HOOK_TOKEN: "", TERMBEACON_TERMINAL_ID: "" },
  });
  assert.equal(result.stderr.trim(), "");
});

test("Claude child and informational events do not report a main-turn state", async () => {
  assert.equal(statusForEvent("SubagentStop"), undefined);
  assert.equal(statusForEvent("TaskCompleted"), undefined);
  assert.equal(statusForEvent("unknown"), undefined);
  assert.equal(statusForEvent("Notification", { notification_type: "auth_success" }), undefined);
  assert.equal(statusForEvent("Notification", { notification_type: "permission_prompt" }), "waiting");
  assert.equal(statusForEvent("PermissionRequest"), "waiting");
  assert.equal(statusForEvent("Stop"), "completed");
});

test("retry keeps event identity and timestamp until a transient failure recovers", async () => {
  const requests = [];
  const sleeps = [];
  const ok = await post({ event: "Stop", status: "completed", occurredAt: 1234 }, {
    env: { TERMBEACON_HOOK_PORT: "1", TERMBEACON_HOOK_TOKEN: "test", TERMBEACON_TERMINAL_ID: "t1" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) throw new Error("connection reset");
      return { ok: requests.length === 3, status: requests.length === 3 ? 204 : 503 };
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.equal(ok, true);
  assert.equal(requests.length, 3);
  assert.ok(requests[0].eventId);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(requests[0].occurredAt, 1234);
  assert.deepEqual(sleeps, [100, 250]);
});

test("an authentication failure is not retried", async () => {
  let requests = 0;
  const ok = await post({ event: "Stop", status: "completed" }, {
    env: { TERMBEACON_HOOK_PORT: "1", TERMBEACON_HOOK_TOKEN: "test", TERMBEACON_TERMINAL_ID: "t1" },
    fetchImpl: async () => { requests += 1; return { ok: false, status: 403 }; },
  });
  assert.equal(ok, false);
  assert.equal(requests, 1);
});

test("malformed and oversized stdin are ignored", async () => {
  assert.equal(await readStdin(Readable.from(["null"])), null);
  assert.equal(await readStdin(Readable.from(["{bad"])), null);
  assert.equal(await readStdin(Readable.from(["x".repeat(128 * 1024 + 1)])), null);
});

test("a real Claude SubagentStop invocation sends no completion event", async (t) => {
  const events = [];
  const server = createHookServer({ onEvent: (event) => events.push(event) });
  const port = await server.start();
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], {
      env: { ...process.env, TERMBEACON_HOOK_PORT: String(port), TERMBEACON_HOOK_TOKEN: server.token, TERMBEACON_TERMINAL_ID: "main" },
    }, (error) => error ? reject(error) : resolve());
    child.stdin.end(JSON.stringify({ hook_event_name: "SubagentStop", session_id: "main" }));
  });
  assert.deepEqual(events, []);
});

test("Electron's empty stdin wrapper still reads the inherited Windows pipe", async () => {
  const bytes = Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "会话-中文" }));
  let offset = 0;
  const emptyStdin = { async *[Symbol.asyncIterator]() {} };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(script, "utf8"), {
    module, Buffer,
    process: { stdin: emptyStdin, versions: { electron: "test" } },
    require(name) {
      if (name === "node:fs") return { readSync(fd, target) {
        assert.equal(fd, 0);
        const count = Math.min(7, bytes.length - offset);
        bytes.copy(target, 0, offset, offset + count);
        offset += count;
        return count;
      } };
      return require(name);
    },
  });
  const result = await module.exports.readStdin();
  assert.equal(result.hook_event_name, "Stop");
  assert.equal(result.session_id, "会话-中文");
});
