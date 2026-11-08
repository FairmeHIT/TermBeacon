const test = require("node:test");
const assert = require("node:assert/strict");
const { discoverAll } = require("../src/main/cli-discovery.cjs");

test("development discovery preserves the selected source and diagnostics", async () => {
  const agents = [{ id: "pi", source: "managed", installed: true, executable: "managed/pi", version: "1.5.0", integration: { state: "configured" } }, { id: "codex", installed: true, error: "version unavailable" }];
  const result = await discoverAll({ scan: async () => ({ agents }) });
  assert.equal(result.pi, agents[0]);
  assert.equal(result.codex.error, "version unavailable");
  assert.equal(Object.keys(result).length, 2);
});
