const test = require("node:test");
const assert = require("node:assert/strict");
const { isAgentLaunchInput, withOpenCodeStandalone } = require("../src/main/agent-launch.cjs");

test("plain OpenCode launches use a standalone server", () => {
  assert.equal(isAgentLaunchInput("opencode", "generic"), true);
  assert.equal(withOpenCodeStandalone("opencode\r", "opencode", "generic"), "opencode --standalone\r");
  assert.equal(withOpenCodeStandalone("opencode --continue\r", "opencode --continue", "generic"), "opencode --standalone --continue\r");
});

test("explicit OpenCode server flags are preserved", () => {
  assert.equal(withOpenCodeStandalone("opencode --standalone\r", "opencode --standalone", "generic"), "opencode --standalone\r");
  assert.equal(withOpenCodeStandalone("opencode --server http://127.0.0.1:1\r", "opencode --server http://127.0.0.1:1", "generic"), "opencode --server http://127.0.0.1:1\r");
});

// Interactive typing sends the command and the Enter key as separate PTY
// chunks, so the command text is already on the shell line when the newline
// arrives. Without handling that shape the flag never reaches the shell and
// opencode attaches to the shared background service, where the hook plugin
// cannot see TermBeacon's per-PTY TERMBEACON_* variables.
test("a standalone Enter-only chunk appends the flag to the typed line", () => {
  assert.equal(withOpenCodeStandalone("\r", "opencode", "generic"), " --standalone\r");
  assert.equal(withOpenCodeStandalone("\n", "opencode", "generic"), " --standalone\n");
  assert.equal(withOpenCodeStandalone("\r", "opencode --continue", "generic"), " --standalone\r");
  assert.equal(withOpenCodeStandalone(" \r", "opencode", "generic"), " --standalone\r");
});

test("the Enter-only rewrite still honours the escape hatches", () => {
  assert.equal(withOpenCodeStandalone("\r", "opencode --standalone", "generic"), "\r");
  assert.equal(withOpenCodeStandalone("\r", "opencode --server http://127.0.0.1:1", "generic"), "\r");
  assert.equal(withOpenCodeStandalone("\r", "npm test", "generic"), "\r");
  assert.equal(withOpenCodeStandalone("\r", "opencode", "opencode"), "\r");
  assert.equal(withOpenCodeStandalone("\r", undefined, "generic"), "\r");
});

test("only a generic shell launch is rewritten", () => {
  assert.equal(withOpenCodeStandalone("opencode\r", "opencode", "opencode"), "opencode\r");
  assert.equal(withOpenCodeStandalone("claude\r", "claude", "generic"), "claude\r");
  assert.equal(isAgentLaunchInput("opencode run task", "generic"), true);
});
