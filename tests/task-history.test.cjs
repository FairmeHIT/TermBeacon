const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanTaskPrompt, applyTaskEvent, settleTask, markInterrupted, restoreAttachedTasks, restoredTerminalRecovery } = require("../src/main/task-history.cjs");

test("cleanTaskPrompt removes terminal decoration and keeps the submitted command", () => {
  assert.equal(cleanTaskPrompt("\u001b[?2004h  npm test\r\n"), "npm test");
  assert.equal(cleanTaskPrompt("\u0003"), undefined);
  assert.equal(cleanTaskPrompt("   "), undefined);
  assert.equal(cleanTaskPrompt("x".repeat(700)).length, 500);
});

test("task events form a resumable lifecycle", () => {
  let tasks = applyTaskEvent([], { terminalId: "t1", current: "working", at: 10, summary: "running" }, "npm test");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].prompt, "npm test");
  tasks = applyTaskEvent(tasks, { terminalId: "t1", current: "awaiting-input", at: 20, summary: "confirm" });
  assert.equal(tasks[0].state, "awaiting-input");
  tasks = applyTaskEvent(tasks, { terminalId: "t1", current: "completed-unseen", at: 40, summary: "done" });
  assert.equal(tasks[0].state, "completed");
  assert.equal(tasks[0].finishedAt, 40);
  assert.equal(tasks[0].summary, "done");
  tasks = applyTaskEvent(tasks, { terminalId: "t1", current: "working", at: 50 }, "npm test again");
  tasks = settleTask(tasks, "t1", "error", 60, "failed");
  assert.equal(tasks.at(-1).state, "error");
  assert.equal(tasks.at(-1).error, "failed");
});

test("retest attempts keep their source and batch metadata", () => {
  const tasks = applyTaskEvent([], { terminalId: "t1", current: "working", at: 10 }, "npm test", {
    batchId: "batch-1",
    retestOf: "task-1",
    attempt: 2,
  });
  assert.equal(tasks[0].batchId, "batch-1");
  assert.equal(tasks[0].retestOf, "task-1");
  assert.equal(tasks[0].attempt, 2);
});

test("active tasks become interrupted and resumable after restart", () => {
  const tasks = [{ id: "task-1", terminalId: "t1", startedAt: 1, state: "working", prompt: "run" }];
  const result = markInterrupted(tasks, 20);
  assert.equal(result[0].state, "interrupted");
  assert.equal(result[0].recoveryState, "resumable");
  assert.equal(result[0].finishedAt, 20);
});

test("reconnecting restores only tasks that were active when the app closed", () => {
  const active = { id: "active", terminalId: "t1", startedAt: 1, state: "awaiting-input", summary: "confirm" };
  const old = { id: "old", terminalId: "t1", startedAt: 0, state: "interrupted", error: "previous interruption" };
  const other = { id: "other", terminalId: "t2", startedAt: 1, state: "working" };
  const restored = restoreAttachedTasks(markInterrupted([old, active, other], 20), "t1", new Map([[active.id, active], [other.id, other]]));
  assert.deepEqual(restored[0], old);
  assert.deepEqual(restored[1], { ...active, recoveryState: "recovered" });
  assert.equal(restored[2].state, "interrupted");
});

test("a restored CLI offers resume when its old process is gone", () => {
  for (const state of ["ready", "completed-unseen", "working", "stopped"]) {
    assert.equal(restoredTerminalRecovery({ agentType: "codex", state }, false), "resumable");
  }
  assert.equal(restoredTerminalRecovery({ agentType: "generic" }, false), "none");
  assert.equal(restoredTerminalRecovery({ agentType: "codex" }, true), "recovered");
});
