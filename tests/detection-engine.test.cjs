const test = require("node:test");
const assert = require("node:assert/strict");
const { createDetector } = require("../src/main/detection-engine.cjs");

function make() {
  const updates = [];
  const detector = createDetector("generic", (update) => updates.push(update));
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