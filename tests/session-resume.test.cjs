const test = require("node:test");
const assert = require("node:assert/strict");
const { getResumeSpec } = require("../src/main/session-resume.cjs");

test("Claude resumes a specific session or latest session", () => {
  assert.deepEqual(getResumeSpec({ agentType: "claude", sessionId: "abc" }).args, ["--resume", "abc"]);
  assert.deepEqual(getResumeSpec({ agentType: "claude" }).args, ["--continue"]);
});

test("OpenCode always uses standalone mode", () => {
  const spec = getResumeSpec({ agentType: "opencode", sessionId: "s-1", shell: "powershell.exe" });
  assert.deepEqual(spec.args, ["--standalone", "--session", "s-1"]);
  assert.equal(spec.program, "opencode");
});

test("Codex uses its resume subcommand", () => {
  assert.deepEqual(getResumeSpec({ agentType: "codex", sessionId: "c-1" }).args, ["resume", "c-1"]);
  assert.deepEqual(getResumeSpec({ agentType: "codex" }).args, ["resume", "--last"]);
});

test("resume adapters return raw arguments for the shared launch service to quote", () => {
  assert.equal(getResumeSpec({ agentType: "generic" }).supported, false);
  assert.deepEqual(getResumeSpec({ agentType: "pi", sessionId: "a'b" }).args, ["--session", "a'b"]);
  assert.equal(getResumeSpec({ agentType: "pi" }).command, undefined);
  assert.equal(getResumeSpec({ agentType: "claude", sessionId: "x".repeat(257) }).mode, "latest");
});
