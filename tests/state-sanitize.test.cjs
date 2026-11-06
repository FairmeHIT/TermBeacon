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
