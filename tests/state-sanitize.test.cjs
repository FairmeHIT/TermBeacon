const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeState, defaultState } = require("../src/main/state-sanitize.cjs");

const validTerminal = { id: "t1", title: "终端 1", cwd: "C:\\", agentType: "claude", state: "ready", alive: false, lastActivityAt: 1 };

test("returns the default state for non-object or wrong-schema input", () => {
  assert.deepEqual(sanitizeState(null), defaultState());
  assert.deepEqual(sanitizeState(undefined), defaultState());
  assert.deepEqual(sanitizeState("string"), defaultState());
  assert.deepEqual(sanitizeState({ schemaVersion: 2, terminals: [validTerminal] }), defaultState());
});

test("keeps valid terminals and workspaces, prunes dangling workspace references", () => {
  const input = {
    schemaVersion: 1,
    workspaces: [{ id: "default", name: "默认工作区", terminalIds: ["t1", "ghost"] }],
    terminals: [validTerminal],
    activeTerminalId: "t1",
  };
  const result = sanitizeState(input);
  assert.equal(result.terminals.length, 1);
  assert.deepEqual(result.workspaces[0].terminalIds, ["t1"]);
  assert.equal(result.activeTerminalId, "t1");
});

test("preserves the manual terminal title pin", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [{ id: "default", name: "默认工作区", terminalIds: ["t1"] }],
    terminals: [{ ...validTerminal, title: "我的任务", titlePinned: true }],
  });
  assert.equal(result.terminals[0].title, "我的任务");
  assert.equal(result.terminals[0].titlePinned, true);
});

test("preserves a valid default new terminal agent and drops invalid values", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [],
    defaultNewTerminalAgent: "codex",
  });
  assert.equal(result.defaultNewTerminalAgent, "codex");

  const invalid = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [],
    defaultNewTerminalAgent: "not-an-agent",
  });
  assert.equal(invalid.defaultNewTerminalAgent, undefined);
});

test("drops the removed Codex launch-argument preference", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [],
    defaultCodexArgs: " --yolo -m wb/cn:kimi-k3.1-pro ",
    defaultCodexProfile: " bifrost ",
  });
  assert.equal(result.defaultCodexArgs, undefined);
  assert.equal(result.defaultCodexProfile, undefined);
});

test("preserves the automatic session-resume preference", () => {
  for (const value of [true, false]) {
    const result = sanitizeState({ schemaVersion: 1, workspaces: [], terminals: [], autoResumeOnStart: value });
    assert.equal(result.autoResumeOnStart, value);
  }
  const invalid = sanitizeState({ schemaVersion: 1, workspaces: [], terminals: [], autoResumeOnStart: "yes" });
  assert.equal(invalid.autoResumeOnStart, undefined);
});

test("preserves the opencode theme-sync preference", () => {
  for (const value of [true, false]) {
    const result = sanitizeState({ schemaVersion: 1, workspaces: [], terminals: [], opencodeThemeSync: value });
    assert.equal(result.opencodeThemeSync, value);
  }
  const invalid = sanitizeState({ schemaVersion: 1, workspaces: [], terminals: [], opencodeThemeSync: "on" });
  assert.equal(invalid.opencodeThemeSync, undefined);
});

test("drops any terminal rowPinned field left over from older versions", () => {
  const result = sanitizeState({ schemaVersion: 1, workspaces: [], terminals: [{ ...validTerminal, rowPinned: true }] });
  assert.equal(result.terminals[0].rowPinned, undefined);
});

test("clamps the workspace/terminal section ratio into a usable band", () => {  for (const [input, expected] of [[0.5, 0.5], [0.05, 0.1], [1.2, 0.95], [-3, 0.1], [0.42, 0.42]]) {
    const result = sanitizeState({ schemaVersion: 1, workspaces: [], terminals: [], workspaceSectionRatio: input });
    assert.equal(result.workspaceSectionRatio, expected);
  }
  const invalid = sanitizeState({ schemaVersion: 1, workspaces: [], terminals: [], workspaceSectionRatio: "half" });
  assert.equal(invalid.workspaceSectionRatio, undefined);
});

test("preserves the close-to-tray preference and balloon flag", () => {  for (const preference of ["ask", "minimize-to-tray", "exit"]) {
    const result = sanitizeState({
      schemaVersion: 1,
      workspaces: [],
      terminals: [],
      closeToTray: { preference, balloonShown: true },
    });
    assert.deepEqual(result.closeToTray, { preference, balloonShown: true });
  }
  // Unknown preference values drop the whole block so the ask dialog returns.
  const invalidPreference = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [],
    closeToTray: { preference: "hover", balloonShown: true },
  });
  assert.equal(invalidPreference.closeToTray, undefined);
  // Missing balloon flag coerces to false rather than staying undefined.
  const coerced = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [],
    closeToTray: { preference: "minimize-to-tray" },
  });
  assert.deepEqual(coerced.closeToTray, { preference: "minimize-to-tray", balloonShown: false });
  // A malformed block is dropped entirely.
  const malformed = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [],
    closeToTray: "yes",
  });
  assert.equal(malformed.closeToTray, undefined);
});

test("preserves workspace folder paths and manual name pins", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [
      { id: "w1", name: "my-project", cwd: "D:\\work\\my-project", namePinned: true, terminalIds: ["t1"] },
      { id: "w2", name: "B", cwd: "   ", terminalIds: [] },
    ],
    terminals: [validTerminal],
  });
  assert.equal(result.workspaces[0].cwd, "D:\\work\\my-project");
  assert.equal(result.workspaces[0].namePinned, true);
  // Blank folder paths are dropped so the UI shows "未设置目录" instead.
  assert.equal(result.workspaces[1].cwd, undefined);
  assert.equal(result.workspaces[1].namePinned, undefined);
});

test("drops malformed terminals and invalid agent types instead of failing", () => {
  const input = {
    schemaVersion: 1,
    workspaces: [],
    terminals: [
      validTerminal,
      { id: "t2" },
      { id: "t3", title: "x", cwd: "C:\\", agentType: "not-an-agent" },
      { id: "t4", title: "x", cwd: "C:\\", agentType: "codex", state: "bogus-state" },
    ],
    activeTerminalId: "t4",
  };
  const result = sanitizeState(input);
  assert.equal(result.terminals.length, 1);
  assert.equal(result.terminals[0].id, "t1");
  // Active id fell back to the first surviving terminal.
  assert.equal(result.activeTerminalId, "t1");
});

test("falls back to the first terminal when the active id is missing", () => {
  const input = {
    schemaVersion: 1,
    workspaces: [],
    terminals: [validTerminal, { ...validTerminal, id: "t2" }],
    activeTerminalId: "ghost",
  };
  const result = sanitizeState(input);
  assert.equal(result.activeTerminalId, "t1");
});

test("preserves a valid activeWorkspaceId and falls back when invalid", () => {
  const validInput = {
    schemaVersion: 1,
    workspaces: [{ id: "w1", name: "A", terminalIds: ["t1"] }, { id: "w2", name: "B", terminalIds: [] }],
    terminals: [validTerminal],
    activeTerminalId: "t1",
    activeWorkspaceId: "w2",
  };
  assert.equal(sanitizeState(validInput).activeWorkspaceId, "w2");

  const invalidInput = { schemaVersion: 1, workspaces: [{ id: "w1", name: "A", terminalIds: [] }], terminals: [], activeWorkspaceId: "ghost" };
  assert.equal(sanitizeState(invalidInput).activeWorkspaceId, "w1");
});

test("clamps persisted layout and window bounds", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [],
    sidebarWidth: 9999,
    windowBounds: { width: 1, height: 99999, x: 40.7, y: -12.4, isMaximized: true },
  });
  assert.equal(result.sidebarWidth, 460);
  assert.deepEqual(result.windowBounds, { width: 900, height: 2160, x: 41, y: -12, isMaximized: true });
});

test("keeps workspace usage metadata and drops contradictory flags", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [
      { id: "w1", name: "a", terminalIds: [], lastUsedAt: 1_700_000_000_000, hidden: true, keepVisible: true },
      { id: "w2", name: "b", terminalIds: [], lastUsedAt: -5, hidden: "yes", keepVisible: true },
      { id: "w3", name: "c", terminalIds: [], lastUsedAt: 1.5 },
    ],
    terminals: [],
  });
  assert.equal(result.workspaces[0].lastUsedAt, 1_700_000_000_000);
  // `hidden` is the last user action, so it wins over a stale pin.
  assert.equal(result.workspaces[0].hidden, true);
  assert.equal(result.workspaces[0].keepVisible, undefined);
  // Malformed timestamps and non-boolean flags are dropped, not repaired.
  assert.equal(result.workspaces[1].lastUsedAt, undefined);
  assert.equal(result.workspaces[1].hidden, undefined);
  assert.equal(result.workspaces[1].keepVisible, true);
  assert.equal(result.workspaces[2].lastUsedAt, undefined);
});

test("keeps bounded task history only for known terminals", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [{ id: "default", name: "默认工作区", terminalIds: ["t1"] }],
    terminals: [validTerminal],
    tasks: [
      { id: "task-1", terminalId: "t1", startedAt: 10, state: "working", prompt: "  run tests  " },
      { id: "task-ghost", terminalId: "ghost", startedAt: 20, state: "completed" },
      { id: "task-bad", terminalId: "t1", startedAt: "bad", state: "completed" },
    ],
  });
  assert.deepEqual(result.tasks, [{ id: "task-1", terminalId: "t1", startedAt: 10, state: "working", prompt: "run tests" }]);
});

test("preserves bounded recovery metadata without accepting malformed session ids", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [{ id: "default", name: "默认工作区", terminalIds: ["t1"] }],
    terminals: [{ ...validTerminal, state: "stopped", lastSessionId: "session-1", lastSessionAgent: "claude", resumeAvailable: true, recoveryState: "resumable", resumeError: "  interrupted  " }],
    tasks: [{ id: "task-1", terminalId: "t1", startedAt: 1, state: "interrupted", recoveryState: "resumable" }],
  });
  assert.equal(result.terminals[0].lastSessionId, "session-1");
  assert.equal(result.terminals[0].lastSessionAgent, "claude");
  assert.equal(result.terminals[0].recoveryState, "resumable");
  assert.equal(result.terminals[0].resumeError, "interrupted");
  assert.equal(result.tasks[0].state, "interrupted");
  assert.equal(result.tasks[0].recoveryState, "resumable");
  const malformed = sanitizeState({
    schemaVersion: 1,
    workspaces: [],
    terminals: [{ ...validTerminal, lastSessionId: "bad\nvalue" }],
  });
  assert.equal(malformed.terminals.length, 0);
});

test("drops a persisted session id that belongs to another CLI", () => {
  // A terminal that ran `claude` and was later labelled `opencode` kept a
  // Claude UUID, so resume built `opencode --session <uuid>` and failed.
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [{ id: "default", name: "默认工作区", terminalIds: ["t1", "t2", "t3", "t4", "t5"] }],
    terminals: [
      { ...validTerminal, id: "t1", agentType: "opencode", lastSessionId: "b8e33a24-47fb-4738-a098-f96998b398e3", lastSessionAgent: "claude" },
      { ...validTerminal, id: "t2", agentType: "claude", lastSessionId: "ses_e25baf5ccffe", lastSessionAgent: "claude" },
      { ...validTerminal, id: "t3", agentType: "opencode", lastSessionId: "ses_e25baf5ccffe", lastSessionAgent: "opencode" },
      { ...validTerminal, id: "t4", agentType: "codex", lastSessionId: "b8e33a24-47fb-4738-a098-f96998b398e3" },
      { ...validTerminal, id: "t5", agentType: "codex", lastSessionId: "codex-uuid", lastSessionAgent: "codex" },
    ],
  });
  assert.equal(result.terminals[0].lastSessionId, undefined);
  assert.equal(result.terminals[1].lastSessionId, undefined);
  assert.equal(result.terminals[2].lastSessionId, "ses_e25baf5ccffe");
  assert.equal(result.terminals[2].lastSessionAgent, "opencode");
  // A UUID is not proof of ownership; without the owner field it is legacy.
  assert.equal(result.terminals[3].lastSessionId, undefined);
  assert.equal(result.terminals[4].lastSessionId, "codex-uuid");
  assert.equal(result.terminals[4].lastSessionAgent, "codex");
});

test("preserves bounded retest attempt metadata", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [{ id: "default", name: "默认工作区", terminalIds: ["t1"] }],
    terminals: [validTerminal],
    tasks: [{ id: "task-2", terminalId: "t1", startedAt: 2, state: "completed", batchId: "batch-1", retestOf: "task-1", attempt: 2 }],
  });
  assert.equal(result.tasks[0].batchId, "batch-1");
  assert.equal(result.tasks[0].retestOf, "task-1");
  assert.equal(result.tasks[0].attempt, 2);
});

test("normalizes legacy terminal fields and keeps the active terminal inside its workspace", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [
      { id: "w1", name: "A", terminalIds: ["t1"] },
      { id: "w2", name: "B", terminalIds: ["t2"] },
    ],
    terminals: [
      { id: "t1", title: "  shell  ", cwd: "C:\\", agentType: "generic" },
      { id: "t2", title: "agent", cwd: "C:\\", agentType: "codex", state: "stopped", alive: true, lastActivityAt: -10 },
    ],
    activeWorkspaceId: "w1",
    activeTerminalId: "t2",
  });
  assert.equal(result.terminals[0].state, "ready");
  assert.equal(result.terminals[0].alive, false);
  assert.equal(result.terminals[0].title, "shell");
  assert.equal(result.terminals[1].lastActivityAt, 0);
  assert.equal(result.activeTerminalId, "t1");
});

test("keeps each workspace's remembered terminal only when it still belongs to it", () => {
  const result = sanitizeState({
    schemaVersion: 1,
    workspaces: [
      { id: "w1", name: "A", terminalIds: ["t1", "t2"], lastActiveTerminalId: "t2" },
      { id: "w2", name: "B", terminalIds: [], lastActiveTerminalId: "t9" },
      { id: "w3", name: "C", terminalIds: ["t3"], lastActiveTerminalId: 42 },
    ],
    terminals: [
      validTerminal,
      { ...validTerminal, id: "t2" },
      { ...validTerminal, id: "t3" },
    ],
  });
  assert.equal(result.workspaces[0].lastActiveTerminalId, "t2");
  // Dangling or malformed references are dropped rather than fatal.
  assert.equal(result.workspaces[1].lastActiveTerminalId, undefined);
  assert.equal(result.workspaces[2].lastActiveTerminalId, undefined);
});
