const test = require("node:test");
const assert = require("node:assert/strict");
const { containsTermBeaconHook, inspectPreflight } = require("../scripts/cli-preflight.cjs");

test("preflight detects nested Claude Hook configuration without reading secrets", () => {
  assert.equal(containsTermBeaconHook({ hooks: [{ command: "node C:/TermBeacon/scripts/termbeacon-hook.cjs" }] }), true);
  assert.equal(containsTermBeaconHook({ hooks: [{ command: "node other-hook.cjs" }] }), false);
});

test("preflight reports installed CLIs and readiness separately from optional integrations", () => {
  const result = inspectPreflight({
    discovered: {
      claude: { installed: true, version: "2.1.318", executable: "claude.cmd" },
      codex: { installed: false },
    },
    hookClient: true,
    opencodePlugin: false,
    claudeSettings: true,
  });
  assert.equal(result.readyForOutputCalibration, true);
  assert.equal(result.readyForInteractiveCalibration, false);
  assert.equal(result.cli.claude.version, "2.1.318");
  assert.equal(result.opencodePlugin, false);

  const complete = inspectPreflight({
    discovered: { opencode: { installed: true }, claude: { installed: true } },
    hookClient: true,
    opencodePlugin: true,
    claudeSettings: true,
  });
  assert.equal(complete.readyForInteractiveCalibration, true);
});
