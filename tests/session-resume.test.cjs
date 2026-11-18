const test = require("node:test");
const assert = require("node:assert/strict");
const { getResumeSpec, sessionIdFitsAgent, autoResumeCandidates } = require("../src/main/session-resume.cjs");

test("Claude resumes a specific session or latest session", () => {
  assert.deepEqual(getResumeSpec({ agentType: "claude", sessionId: "abc", sessionAgent: "claude" }).args, ["--resume", "abc"]);
  assert.deepEqual(getResumeSpec({ agentType: "claude" }).args, ["--continue"]);
});

test("OpenCode always uses standalone mode", () => {
  const spec = getResumeSpec({ agentType: "opencode", sessionId: "ses_e25baf5ccffeMyS98eLqAV350G", sessionAgent: "opencode", shell: "powershell.exe" });
  assert.deepEqual(spec.args, ["--standalone", "--session", "ses_e25baf5ccffeMyS98eLqAV350G"]);
  assert.equal(spec.program, "opencode");
});

test("Codex uses its resume subcommand", () => {
  assert.deepEqual(getResumeSpec({ agentType: "codex", sessionId: "c-1", sessionAgent: "codex" }).args, ["resume", "c-1"]);
});

test("Codex without a session id opens the picker instead of --last", () => {
  // `codex resume --last` is cwd-filtered, so every terminal in one workspace
  // restored the same (newest) conversation. The picker makes the choice
  // explicit instead of silently reopening a sibling's thread.
  const spec = getResumeSpec({ agentType: "codex" });
  assert.deepEqual(spec.args, ["resume"]);
  assert.equal(spec.mode, "picker");
  assert.match(spec.note, /会话列表/);
});

test("resume adapters return raw arguments for the shared launch service to quote", () => {
  assert.equal(getResumeSpec({ agentType: "generic" }).supported, false);
  assert.deepEqual(getResumeSpec({ agentType: "pi", sessionId: "a'b", sessionAgent: "pi" }).args, ["--session", "a'b"]);
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
  const claude = getResumeSpec({ agentType: "claude", sessionId: "ses_e25baf5ccffe", sessionAgent: "claude" });
  assert.equal(claude.mode, "latest");
  assert.equal(claude.sessionId, undefined);
  const codex = getResumeSpec({ agentType: "codex", sessionId: "ses_e25baf5ccffe", sessionAgent: "codex" });
  assert.equal(codex.mode, "picker");
  assert.equal(codex.sessionId, undefined);
});

test("a matching session owner is required before an id is resumed", () => {
  const claudeId = "b8e33a24-47fb-4738-a098-f96998b398e3";
  for (const agentType of ["pi", "opencode"]) {
    const spec = getResumeSpec({ agentType, sessionId: claudeId, sessionAgent: "claude" });
    assert.equal(spec.mode, "latest");
    assert.equal(spec.sessionId, undefined);
  }
  // Codex cannot prove which conversation belongs here, so it asks.
  assert.equal(getResumeSpec({ agentType: "codex", sessionId: claudeId, sessionAgent: "claude" }).mode, "picker");
  for (const agentType of ["claude", "codex", "pi"]) {
    const spec = getResumeSpec({ agentType, sessionId: claudeId, sessionAgent: agentType });
    assert.equal(spec.mode, "session-id", `${agentType} should resume its own id`);
  }
  // Legacy ids have no owner, and UUID-like formats cannot distinguish
  // Claude, Codex, and Pi.
  const legacy = getResumeSpec({ agentType: "codex", sessionId: claudeId });
  assert.equal(legacy.mode, "picker");
  assert.equal(legacy.sessionId, undefined);
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

test("automatic startup resume only selects exact, owned, resumable sessions", () => {
  const claudeId = "b8e33a24-47fb-4738-a098-f96998b398e3";
  const terminals = [
    { id: "active", agentType: "claude", state: "working", lastSessionId: claudeId, lastSessionAgent: "claude", recoveryState: "resumable" },
    { id: "opencode", agentType: "opencode", state: "ready", lastSessionId: "ses_abc", lastSessionAgent: "opencode", recoveryState: "resumable" },
    { id: "plain", agentType: "generic", state: "ready", lastSessionId: "ses_abc", lastSessionAgent: "opencode" },
    { id: "foreign", agentType: "codex", state: "ready", lastSessionId: claudeId, lastSessionAgent: "claude" },
    { id: "unsupported", agentType: "codex", state: "error", lastSessionId: claudeId, lastSessionAgent: "codex", recoveryState: "unsupported" },
    { id: "opted-out", agentType: "claude", state: "ready", lastSessionId: claudeId, lastSessionAgent: "claude", resumeAvailable: false },
    { id: "closed", agentType: "claude", state: "stopped", lastSessionId: claudeId, lastSessionAgent: "claude", recoveryState: "resumable" },
    { id: "no-session", agentType: "claude", state: "ready", recoveryState: "resumable" },
  ];
  assert.deepEqual(autoResumeCandidates(terminals), ["active", "opencode"]);
  assert.deepEqual(autoResumeCandidates(terminals, false), []);
  assert.deepEqual(autoResumeCandidates(null), []);
});
