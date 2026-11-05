const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCreateRequest,
  normalizeWriteRequest,
  normalizeResizeRequest,
  normalizeTerminalRequest,
} = require("../src/main/pty-validation.cjs");
const { defaultCwd, defaultShell } = require("../src/main/platform.cjs");

const cwd = process.platform === "win32" ? "C:\\" : "/";

test("uses the platform home directory when cwd is omitted", () => {
  assert.equal(normalizeCreateRequest({ terminalId: "t1" }).cwd, defaultCwd());
});

test("normalizes a valid PTY create request", () => {
  assert.deepEqual(normalizeCreateRequest({ terminalId: "t1", cwd }), {
    terminalId: "t1",
    title: "t1",
    cwd,
    shell: defaultShell(),
    args: [],
    env: {},
    cols: 120,
    rows: 32,
    agentType: "generic",
  });
});

test("rejects relative cwd and invalid dimensions", () => {
  assert.throws(() => normalizeCreateRequest({ terminalId: "t1", cwd: "." }), { code: "INVALID_CWD" });
  assert.throws(() => normalizeCreateRequest({ terminalId: "t1", cwd, cols: 1 }), { code: "INVALID_DIMENSION" });
  assert.throws(() => normalizeResizeRequest({ terminalId: "t1", cols: 501, rows: 20 }), { code: "INVALID_DIMENSION" });
});

test("validates write and terminal control payloads", () => {
  assert.deepEqual(normalizeWriteRequest({ terminalId: "t1", data: "echo ok\r" }), { terminalId: "t1", data: "echo ok\r" });
  assert.deepEqual(normalizeTerminalRequest({ terminalId: "t1" }, "pty:kill"), { terminalId: "t1" });
  assert.throws(() => normalizeWriteRequest({ terminalId: "t1", data: "" }), { code: "INVALID_REQUEST" });
  assert.throws(() => normalizeTerminalRequest({}, "pty:kill"), { code: "INVALID_REQUEST" });
});
