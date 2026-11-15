const test = require("node:test");
const assert = require("node:assert/strict");
const { getResumeSpec, sessionIdFitsAgent } = require("../src/main/session-resume.cjs");

test("Claude resumes a specific session or latest session", () => {
  assert.deepEqual(getResumeSpec({ agentType: "claude", sessionId: "abc" }).args, ["--resume", "abc"]);
  assert.deepEqual(getResumeSpec({ agentType: "claude" }).args, ["--continue"]);
});

test("OpenCode always uses standalone mode", () => {
  const spec = getResumeSpec({ agentType: "opencode", sessionId: "ses_e25baf5ccffeMyS98eLqAV350G", shell: "powershell.exe" });
  assert.deepEqual(spec.args, ["--standalone", "--session", "ses_e25baf5ccffeMyS98eLqAV350G"]);
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

test("a Claude UUID is never sent to opencode's --session flag", () => {
  // Regression: a terminal that ran `claude` but was labelled `opencode` built
  // `opencode --standalone --session b8e33a24-…`, which opencode rejects with
  // `Expected a string starting with "ses"` at ["sessionID"].
  const spec = getResumeSpec({ agentType: "opencode", sessionId: "b8e33a24-47fb-4738-a098-f96998b398e3" });
  assert.equal(spec.supported, true);
  assert.equal(spec.mode, "latest");
  assert.equal(spec.sessionId, undefined);
  assert.deepEqual(spec.args, ["--standalone", "--continue"]);
  assert.match(spec.note, /opencode/);
});

test("an opencode session id is never sent to Claude or Codex", () => {
  for (const agentType of ["claude", "codex"]) {
    const spec = getResumeSpec({ agentType, sessionId: "ses_e25baf5ccffe" });
    assert.equal(spec.mode, "latest");
    assert.equal(spec.sessionId, undefined);
  }
});

test("session id shape is matched to the CLI that will open it", () => {
  assert.equal(sessionIdFitsAgent("opencode", "ses_abc"), true);
  assert.equal(sessionIdFitsAgent("opencode", "b8e33a24-47fb-4738-a098-f96998b398e3"), false);
  assert.equal(sessionIdFitsAgent("claude", "b8e33a24-47fb-4738-a098-f96998b398e3"), true);
  assert.equal(sessionIdFitsAgent("claude", "ses_abc"), false);
  assert.equal(sessionIdFitsAgent("codex", "ses_abc"), false);
  // Generic terminals and adapters with unknown formats stay permissive.
  assert.equal(sessionIdFitsAgent("generic", "anything"), true);
  assert.equal(sessionIdFitsAgent("pi", "anything"), true);
  assert.equal(sessionIdFitsAgent("opencode", ""), false);
  assert.equal(sessionIdFitsAgent("opencode", undefined), false);
});
