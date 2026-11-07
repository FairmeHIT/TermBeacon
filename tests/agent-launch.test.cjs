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

test("only a generic shell launch is rewritten", () => {
  assert.equal(withOpenCodeStandalone("opencode\r", "opencode", "opencode"), "opencode\r");
  assert.equal(withOpenCodeStandalone("claude\r", "claude", "generic"), "claude\r");
  assert.equal(isAgentLaunchInput("opencode run task", "generic"), true);
});
