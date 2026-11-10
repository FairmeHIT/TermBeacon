const test = require("node:test");
const assert = require("node:assert/strict");
const { createDetector, parseOscTitle } = require("../src/main/detection-engine.cjs");

function make() {
  const updates = [];
  const detector = createDetector("generic", (update) => updates.push(update));
  return { detector, updates };
}

function makeAgent(agent) {
  const updates = [];
  const detector = createDetector(agent, (update) => updates.push(update));
  return { detector, updates };
}

test("prompt return after quiet confirmation becomes completed-unseen", () => {
  const { detector, updates } = make();
  detector.input("build project\r");
  detector.output("Running...", 1000);
  detector.output("Done\r\n$ ", 2000);
  detector.tick(4499);
  assert.equal(updates.at(-1).current, "working");
  detector.tick(4500);
  assert.equal(updates.at(-1).current, "completed-unseen");
});

test("quiet output without structural evidence does not complete", () => {
  const { detector, updates } = make();
  detector.input("long task\r");
  detector.output("still processing", 1000);
  detector.tick(10000);
  assert.equal(updates.at(-1).current, "working");
});

test("tool in flight blocks completion candidate", () => {
  const { detector, updates } = make();
  detector.input("run tests\r");
  detector.output("Executing tool", 1000);
  detector.output("$ ", 2000);
  detector.tick(6000);
  assert.equal(updates.at(-1).current, "working");
});

test("viewing completed terminal returns it to ready", () => {
  const { detector, updates } = make();
  detector.input("task\r");
  detector.output("Done\r\n$ ", 1000);
  detector.tick(3500);
  detector.viewed();
  assert.equal(updates.at(-1).current, "ready");
});

test("hook failure and completion are high confidence signals", () => {
  const { detector, updates } = make();
  detector.hook("task started", "started");
  assert.equal(updates.at(-1).current, "working");
  detector.hook("task failed", "failed");
  assert.equal(updates.at(-1).current, "error");
});

test("OpenCode transient provider errors do not override a retrying task", () => {
  const { detector, updates } = makeAgent("opencode");
  detector.input("run task\r");
  detector.output("Thinking...\r\n", 1000);
  detector.output("request failed, retrying...\r\nThinking...\r\n", 2000);
  assert.equal(detector.runtime.state, "working");
  assert.equal(updates.some((update) => update.current === "error"), false);
});

test("completion marker split across PTY output chunks still completes", () => {
  const { detector, updates } = make();
  detector.input("build project\r");
  detector.output("Do", 1000);
  detector.output("ne\r\n$ ", 1100);
  detector.tick(3600);
  assert.equal(updates.at(-1).current, "completed-unseen");
});

test("permission marker split across PTY output chunks enters awaiting-input", () => {
  const { detector, updates } = make();
  detector.input("read file\r");
  detector.output("Allow this", 1000);
  detector.output(" action? [Yes/No]", 1100);
  assert.equal(updates.at(-1).current, "awaiting-input");
});

test("missing tool-end marker is bounded by the tool grace window", () => {
  const { detector, updates } = make();
  detector.input("run tests\r");
  detector.output("Executing tool", 1000);
  detector.output("$ ", 2000);
  detector.tick(9500);
  assert.equal(updates.at(-1).current, "working");
  detector.tick(10000);
  assert.equal(updates.at(-1).current, "completed-unseen");
});

test("OSC completion progress alone does not complete within short quiet windows", () => {
  const { detector, updates } = make();
  detector.input("run task\r");
  detector.output("\u001b]9;4;1;100\u0007", 1000);
  // The old invariant was relaxed: OSC alone can now settle, but only after
  // the extended (3x) quiet window; the normal window must not fire.
  detector.tick(4000);
  assert.equal(updates.at(-1).current, "working");
});

test("OSC progress 100 settles at low confidence after the extended quiet window", () => {
  const { detector, updates } = make();
  detector.input("run task\r");
  detector.output("\u001b]9;4;1;100\u0007", 1000);
  // candidateMs is 1200, oscOnlyConfirmMs is confirmMs * 3 = 7500.
  detector.tick(9000);
  assert.equal(updates.at(-1).current, "completed-unseen");
  assert.equal(updates.at(-1).confidence, 0.6);
  assert.equal(updates.at(-1).source, "osc");
});

test("OSC progress 100 does not settle within the normal confirm window", () => {
  const { detector, updates } = make();
  detector.input("run task\r");
  detector.output("\u001b]9;4;1;100\u0007", 1000);
  detector.tick(4000);
  assert.equal(updates.at(-1).current, "working");
});

test("OSC state 0 counts as completion evidence for the osc-only path", () => {
  const { detector, updates } = make();
  detector.input("run task\r");
  detector.output("\u001b]9;4;0;\u0007", 1000);
  detector.tick(9000);
  assert.equal(updates.at(-1).current, "completed-unseen");
  assert.equal(updates.at(-1).source, "osc");
});

test("OSC completion accelerates a text-evidenced candidate", () => {
  const { detector, updates } = make();
  detector.input("build\r");
  detector.output("\u001b]9;4;1;100\u0007Done\r\n$ ", 1000);
  // confirmMs is 2500, halved to 1250 by OSC evidence; candidate age 1400ms
  // at tick(2400) is beyond it while remaining below the plain 2500ms window.
  detector.tick(2400);
  assert.equal(updates.at(-1).current, "completed-unseen");
  assert.equal(updates.at(-1).confidence, 0.88);
});

test("unarmed OSC progress without user activity never settles", () => {
  const { detector, updates } = make();
  detector.output("\u001b]9;4;1;100\u0007", 1000);
  detector.tick(20000);
  assert.equal(updates.length, 0);
});

test("arrow keys and mouse reports do not arm a task", () => {
  const { detector, updates } = make();
  detector.input("\u001b[A");
  detector.input("\u001b[<0;10;20M");
  detector.output("$ ", 1000);
  detector.tick(5000);
  assert.equal(updates.length, 0);
});

test("bracketed paste still arms a task", () => {
  const { detector, updates } = make();
  detector.input("\u001b[200~dir\u001b[201~");
  assert.equal(updates.at(-1).current, "working");
});

test("cmd.exe prompt completes without any further output chunk", () => {
  const { detector, updates } = make();
  detector.input("dir\r");
  detector.output(" Volume in drive C has no label.\r\nC:\\Users\\me>", 1000);
  detector.tick(3600);
  assert.equal(updates.at(-1).current, "completed-unseen");
});

test("PowerShell prompt is recognized as completion evidence", () => {
  const { detector, updates } = make();
  detector.input("Get-ChildItem\r");
  detector.output("PS C:\\Users\\me>", 1000);
  detector.tick(3600);
  assert.equal(updates.at(-1).current, "completed-unseen");
});

test("an old Done outside the recent evidence window does not confirm", () => {
  const { detector, updates } = make();
  detector.input("build\r");
  detector.output("Done\r\n", 1000);
  detector.output("step one\r\nstep two\r\nstep three\r\nworking on next\r\n", 1100);
  detector.tick(6000);
  assert.equal(updates.at(-1).current, "working");
});

test("bare failed in ordinary log output does not become an error", () => {
  const { detector, updates } = make();
  detector.input("run\r");
  detector.output("warning: failed to read cache\r\n", 1000);
  detector.tick(5000);
  assert.equal(updates.at(-1).current, "working");
});

test("model-unavailable output enters error", () => {
  const { detector, updates } = makeAgent("pi");
  detector.input("run task\r");
  detector.output('Error: Model "definitely-not-a-real-model" not found.\r\n', 1000);
  assert.equal(updates.at(-1).current, "error");
});

test("Claude unrecognized model output enters error", () => {
  const updates = [];
  const detector = createDetector("claude", (update) => updates.push(update));
  detector.input("task\r");
  detector.output("Claude Code doesn't recognize the model \"definitely-not-a-real-model\".\r\n", 1000);
  detector.output("[claude-code:unrecognized_model] {\"model\":\"definitely-not-a-real-model\"}\r\n", 2000);
  assert.equal(updates.at(-1).current, "error");
});

test("provider insufficient balance output enters error", () => {
  const { detector, updates } = makeAgent("pi");
  detector.input("task\r");
  detector.output("402: {\"message\":\"Insufficient Balance\",\"type\":\"insufficient_balance_error\"}\r\n", 1000);
  assert.equal(updates.at(-1).current, "error");
});

test("native Pi running turns become error on a provider failure", () => {
  const { detector, updates } = makeAgent("pi");
  detector.hook("pi.agent_start", "running");
  detector.output("402: {\"message\":\"Insufficient Balance\",\"type\":\"insufficient_balance_error\"}\r\n", 1000);
  assert.equal(updates.at(-1).current, "error");
});

test("Claude-style permission dialog enters awaiting-input", () => {
  const { detector, updates } = make();
  detector.input("read file\r");
  detector.output("Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n", 1000);
  assert.equal(updates.at(-1).current, "awaiting-input");
});

test("OpenCode grant-permission question enters awaiting-input", () => {
  const { detector, updates } = makeAgent("opencode");
  detector.input("run task\r");
  detector.output("Questions\r\nThe `ls` listing above is complete. Do you grant permission to proceed?\r\n1. Grant permission\r\n2. Deny permission\r\n", 1000);
  assert.equal(updates.at(-1).current, "awaiting-input");
});

test("permission output can upgrade a native running turn", () => {
  const { detector, updates } = makeAgent("opencode");
  detector.input("run task\r");
  detector.hook("session.execution.started", "running");
  detector.output("Questions\r\nDo you grant permission to proceed?\r\n1. Grant permission\r\n2. Deny permission\r\n", 1000);
  assert.equal(updates.at(-1).current, "awaiting-input");
});

test("cmd batch termination prompt is not a permission dialog", () => {
  const { detector, updates } = make();
  detector.input("claude\r");
  detector.output("终止批处理操作吗(Y/N)? ", 1000);
  assert.equal(updates.at(-1).current, "working");
});

test("working-looking banner output alone does not arm a task", () => {
  const { detector, updates } = make();
  detector.output("Running commands are available\r\n$ ", 1000);
  detector.tick(10000);
  assert.equal(updates.length, 0);
});

test("launching an agent does not arm a task", () => {
  const { detector, updates } = make();
  detector.launch();
  detector.output("Claude Code v2.1.316\r\n❯ ", 1000);
  detector.tick(6000);
  assert.equal(detector.runtime.state, "ready");
  assert.equal(detector.runtime.armed, false);
  assert.equal(updates.length, 0);
});

test("Claude title spinner returning to idle completes a task", () => {
  const { detector, updates } = makeAgent("claude");
  detector.input("list files\r");
  detector.output("\u001b]0;◐ Claude Code\u0007", 1000);
  detector.output("\u001b]0;✳ Claude Code\u0007", 5000);
  detector.tick(7500);
  assert.equal(updates.at(-1).current, "completed-unseen");
  assert.equal(updates.at(-1).source, "title");
});

test("Codex brief plain-title gap does not complete a task", () => {
  const { detector, updates } = makeAgent("codex");
  detector.input("list files\r");
  detector.output("\u001b]0;⠋ 75_TermBeacon\u0007", 1000);
  detector.output("\u001b]0;75_TermBeacon\u0007", 5000);
  detector.output("\u001b]0;⠙ 75_TermBeacon\u0007", 6000);
  detector.tick(9000);
  assert.equal(updates.at(-1).current, "working");
});

test("idle title without a submitted task does not complete", () => {
  const { detector, updates } = makeAgent("claude");
  detector.output("\u001b]0;✳ Claude Code\u0007", 1000);
  detector.tick(10000);
  assert.equal(updates.length, 0);
  assert.equal(detector.runtime.state, "ready");
});

test("Codex stream disconnect enters error and title idle does not override it", () => {
  const { detector, updates } = makeAgent("codex");
  detector.input("list files\r");
  detector.output("\u001b]0;⠋ 75_TermBeacon\u0007", 1000);
  detector.output("  └ Stream disconnected before completion: Our servers are currently overloaded.\r\n", 2000);
  assert.equal(updates.at(-1).current, "error");
  detector.output("\u001b]0;75_TermBeacon\u0007", 5000);
  detector.tick(9000);
  assert.equal(detector.runtime.state, "error");
});

test("error stays sticky until the user submits again", () => {
  const { detector, updates } = make();
  detector.input("run\r");
  detector.output("Error: fatal\r\n", 1000);
  assert.equal(updates.at(-1).current, "error");
  detector.output("still printing diagnostics\r\n", 2000);
  detector.tick(8000);
  assert.equal(detector.runtime.state, "error");
  detector.input("retry\r");
  assert.equal(detector.runtime.state, "working");
});

test("parseOscTitle accepts BEL and ST terminators", () => {
  assert.equal(parseOscTitle("\u001b]0;✳ Claude Code\u0007"), "✳ Claude Code");
  assert.equal(parseOscTitle("\u001b]2;75_TermBeacon\u001b\\"), "75_TermBeacon");
  assert.equal(parseOscTitle("plain text"), undefined);
});

test("hook waiting survives redraws, title spinners, progress and error-looking prose", () => {
  const { detector } = makeAgent("claude");
  detector.hook("UserPromptSubmit", "running");
  detector.hook("PermissionRequest", "waiting");
  detector.output("\x1b]0;◐ Claude Code\x07Error: an example\r\nDone\r\n$ \x1b]9;4;1;100\x07", 1000);
  detector.tick(90000);
  assert.equal(detector.runtime.state, "awaiting-input");
  detector.hook("PreToolUse", "running");
  assert.equal(detector.runtime.state, "working");
});

test("native running prevents heuristic completion until the native turn ends", () => {
  const { detector, updates } = makeAgent("claude");
  detector.hook("UserPromptSubmit", "running");
  detector.output("\x1b]0;◐ Claude Code\x07", 1000);
  detector.output("\x1b]0;✳ Claude Code\x07Done\r\n$ ", 2000);
  detector.tick(90000);
  assert.equal(detector.runtime.state, "working");
  detector.hook("Stop", "completed");
  assert.equal(detector.runtime.state, "completed-unseen");
  assert.equal(updates.at(-1).source, "hook");
  assert.equal(updates.at(-1).confidence, 0.95);
});

test("native completion immediately clears a tool grace period", () => {
  const { detector } = makeAgent("opencode");
  detector.input("run tool\r");
  detector.output("Executing tool", Date.now());
  assert.equal(detector.runtime.toolInFlight, true);
  detector.hook("session.idle", "completed");
  assert.equal(detector.runtime.state, "completed-unseen");
  assert.equal(detector.runtime.toolInFlight, false);
  detector.output("Running tool\r\nError: old diagnostics");
  assert.equal(detector.runtime.state, "completed-unseen");
});

test("repeated native completion does not relight a viewed task", () => {
  const { detector } = makeAgent("opencode");
  detector.hook("session.idle", "completed");
  detector.viewed();
  detector.hook("session.snapshot", "completed");
  assert.equal(detector.runtime.state, "ready");
  detector.input("new task\r");
  detector.hook("session.status", "running");
  detector.hook("session.idle", "completed");
  assert.equal(detector.runtime.state, "completed-unseen");
});

test("native failure is sticky across output and recovers from a native retry", () => {
  const { detector } = makeAgent("opencode");
  detector.hook("session.execution.failed", "failed");
  detector.output("Thinking... retrying...\r\nDone\r\n$ ", 1000);
  detector.tick(90000);
  assert.equal(detector.runtime.state, "error");
  detector.hook("session.status", "running");
  assert.equal(detector.runtime.state, "working");
});

test("legacy Claude child completion cannot complete the main turn", () => {
  const { detector } = makeAgent("claude");
  detector.hook("UserPromptSubmit", "running");
  assert.equal(detector.hook("SubagentStop", "completed"), false);
  assert.equal(detector.hook("TaskCompleted", "completed"), false);
  assert.equal(detector.runtime.state, "working");
});

test("late retried hooks cannot reverse a newer transition", () => {
  const { detector } = makeAgent("opencode");
  detector.hook("session.idle", "completed", { occurredAt: 2000 });
  assert.equal(detector.hook("session.status", "running", { occurredAt: 1000 }), false);
  assert.equal(detector.runtime.state, "completed-unseen");
});

test("Enter resumes a hook waiting state after arrow-key selection", () => {
  const { detector } = makeAgent("claude");
  detector.hook("PermissionRequest", "waiting");
  detector.input("\x1b[B");
  assert.equal(detector.runtime.state, "awaiting-input");
  detector.input("\r");
  assert.equal(detector.runtime.state, "working");
  assert.equal(detector.runtime.hookStatus, null);
});

test("Codex and Claude titles survive every possible PTY split including the ESC byte", () => {
  for (const [agent, working, idle] of [
    ["codex", "⠋ project", "project"], ["claude", "◐ Claude Code", "✳ Claude Code"],
  ]) {
    for (const end of ["\x07", "\x1b\\"]) {
      const active = `\x1b]0;${working}${end}`;
      const finished = `\x1b]2;${idle}${end}`;
      for (let split = 1; split < active.length; split += 1) {
        const { detector } = makeAgent(agent);
        detector.input("run\r");
        detector.output(active.slice(0, split), 1000);
        detector.output(active.slice(split), 1100);
        const idleSplit = Math.min(split, finished.length - 1);
        detector.output(finished.slice(0, idleSplit), 5000);
        detector.output(finished.slice(idleSplit), 5100);
        detector.tick(8000);
        assert.equal(detector.runtime.state, "completed-unseen", `${agent}, split ${split}`);
      }
    }
  }
});

test("all titles in one chunk are applied in order", () => {
  const { detector } = makeAgent("codex");
  detector.input("run\r");
  detector.output("\x1b]0;⠋ task\x07\x1b]0;task\x07\x1b]0;⠙ task\x07", 1000);
  detector.tick(90000);
  assert.equal(detector.runtime.state, "working");
});

test("progress split at any byte still completes and later active progress invalidates it", () => {
  const sequence = "\x1b]9;4;1;100\x1b\\";
  for (let split = 1; split < sequence.length; split += 1) {
    const { detector } = make();
    detector.input("run\r");
    detector.output(sequence.slice(0, split), 1000);
    detector.output(sequence.slice(split), 1100);
    detector.tick(9000);
    assert.equal(detector.runtime.state, "completed-unseen", `split ${split}`);
  }
  const { detector } = make();
  detector.input("run\r");
  detector.output(sequence + "\x1b]9;4;1;20\x07", 1000);
  detector.tick(90000);
  assert.equal(detector.runtime.state, "working");
});

test("OSC metadata is not evidence of text completion or failure", () => {
  const { detector } = make();
  detector.input("run\r");
  detector.output("\x1b]0;Error: Done\x07", 1000);
  detector.tick(90000);
  assert.equal(detector.runtime.state, "working");
});

test("prompt editing keeps native state and old completion cannot end a new submission", () => {
  const { detector } = makeAgent("claude");
  const old = Date.now() - 1000;
  detector.hook("Stop", "completed", { occurredAt: old });
  detector.input("next prompt");
  assert.equal(detector.runtime.state, "completed-unseen");
  detector.input("\r");
  assert.equal(detector.runtime.state, "working");
  assert.equal(detector.hook("Stop", "completed", { occurredAt: old + 1 }), false);
  assert.equal(detector.runtime.state, "working");
});
