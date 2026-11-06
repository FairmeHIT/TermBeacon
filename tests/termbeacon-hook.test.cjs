const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createHookServer } = require("../src/main/hook-server.cjs");

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

test("hook client is a no-op outside TermBeacon", async () => {
  const result = await run(process.execPath, [script, "completed", "Stop"], {
    env: { ...process.env, TERMBEACON_HOOK_PORT: "", TERMBEACON_HOOK_TOKEN: "", TERMBEACON_TERMINAL_ID: "" },
  });
  assert.equal(result.stderr.trim(), "");
});
