const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const registry = require("../src/main/agent-registry.cjs");
const { createDetector } = require("../src/main/detection-engine.cjs");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "App.tsx"), "utf8");

// Verbatim titles from captures/opencode-plugin-probe-{standalone,attached}.jsonl.
const REAL_STARTUP_TITLE = "C:\\WINDOWS\\system32\\cmd.exe";
const REAL_BOOT_TITLE = "OpenCode";
const REAL_TASK_TITLE = "OC | 列出文件并总结";
const REAL_DONE_TITLE = "OC | OK";

test("opencode recognises the task title shape it actually emits", () => {
  const title = registry.opencode.title;
  assert.ok(title, "opencode must declare a title config like codex and claude");
  assert.equal(title.working.some((pattern) => pattern.test(REAL_TASK_TITLE)), true);
  assert.equal(title.working.some((pattern) => pattern.test(REAL_DONE_TITLE)), true);
  assert.equal(title.working.some((pattern) => pattern.test(REAL_BOOT_TITLE)), false);
  assert.equal(title.working.some((pattern) => pattern.test(REAL_STARTUP_TITLE)), false);
});

// Two real captures (--standalone and attached) both end on `OC | ...`: the
// title never returns to `OpenCode` after a turn. Claiming it does would make
// the sidebar report a completion that the CLI never signalled.
test("opencode does not claim a title-idle completion it never emits", () => {
  assert.deepEqual(registry.opencode.title.idle ?? [], []);
  const updates = [];
  const detector = createDetector("opencode", (update) => updates.push(update));
  detector.input("列出当前目录下的文件，然后用一句话总结\r");
  detector.output(`\u001b]0;${REAL_TASK_TITLE}\u0007`, 1000);
  detector.output(`\u001b]0;${REAL_BOOT_TITLE}\u0007`, 6000);
  detector.tick(90000);
  assert.equal(detector.runtime.state, "working");
  assert.equal(updates.at(-1).current, "working");
});

test("opencode task title raises working without a prompt or completion marker", () => {
  const updates = [];
  const detector = createDetector("opencode", (update) => updates.push(update));
  detector.input("列出当前目录下的文件，然后用一句话总结\r");
  detector.output(`\u001b]0;${REAL_TASK_TITLE}\u0007`, 1000);
  assert.equal(detector.runtime.state, "working");
  // A TUI that never prints a prompt must not complete on silence alone.
  detector.tick(30000);
  assert.equal(detector.runtime.state, "working");
});

test("opencode completes from the hook plugin, not from the title", () => {
  const updates = [];
  const detector = createDetector("opencode", (update) => updates.push(update));
  detector.input("只回复 OK，不要调用任何工具\r");
  detector.output(`\u001b]0;${REAL_TASK_TITLE}\u0007`, 1000);
  detector.hook("session.prompt", "running");
  detector.hook("session.execution.started", "running");
  detector.hook("session.execution.succeeded", "completed");
  assert.equal(updates.at(-1).current, "completed-unseen");
  // Late title traffic from the same turn must not pull the state back.
  detector.output(`\u001b]0;${REAL_DONE_TITLE}\u0007`, 9000);
  assert.equal(detector.runtime.state, "completed-unseen");
});

test("settings explain that opencode completion detection is limited without the plugin", () => {
  assert.match(fs.readFileSync(path.join(__dirname, "../src/renderer/SettingsPage.tsx"), "utf8"), /检测受限/);
});
