const test = require("node:test");
const assert = require("node:assert/strict");
const { getResumeSpec, quoteShellArg } = require("../src/main/session-resume.cjs");

test("Claude resumes a specific session or latest session", () => {
  assert.equal(getResumeSpec({ agentType: "claude", sessionId: "abc", shell: "cmd.exe" }).command, 'claude "--resume" "abc"');
  assert.equal(getResumeSpec({ agentType: "claude", shell: "powershell.exe" }).command, "claude '--continue'");
});

test("OpenCode always uses standalone mode", () => {
  const spec = getResumeSpec({ agentType: "opencode", sessionId: "s-1", shell: "powershell.exe" });
  assert.deepEqual(spec.args, ["--standalone", "--session", "s-1"]);
  assert.equal(spec.command, "opencode '--standalone' '--session' 's-1'");
});

test("Codex uses its resume subcommand", () => {
  assert.equal(getResumeSpec({ agentType: "codex", sessionId: "c-1", shell: "cmd.exe" }).command, 'codex "resume" "c-1"');
  assert.equal(getResumeSpec({ agentType: "codex", shell: "cmd.exe" }).command, 'codex "resume" "--last"');
});

test("generic terminals are unsupported and shell args are quoted", () => {
  assert.equal(getResumeSpec({ agentType: "generic" }).supported, false);
  assert.equal(quoteShellArg("a'b", "powershell.exe"), "'a''b'");
  assert.equal(quoteShellArg('a"b', "cmd.exe"), '"a\\"b"');
  assert.equal(getResumeSpec({ agentType: "claude", sessionId: "x".repeat(257) }).mode, "latest");
});
