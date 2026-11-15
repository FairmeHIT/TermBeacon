const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AUTO_HIDE_IDLE_MS,
  VISIBLE_LIMIT,
  orderWorkspaces,
  recordWorkspaceUse,
  workspaceForTerminal,
  hideWorkspace,
  showWorkspace,
} = require("../src/main/workspace-visibility.cjs");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function workspace(id, usedDaysAgo, extra = {}) {
  return { id, name: id, terminalIds: [], lastUsedAt: NOW - usedDaysAgo * DAY, ...extra };
}

function ids(items) {
  return items.map((item) => item.id);
}

test("workspaces stay in creation order even when usage differs", () => {
  const list = [workspace("a", 1), workspace("b", 0.25), workspace("c", 3)];
  const { visible, hidden } = orderWorkspaces(list, { now: NOW, activeId: "b" });
  assert.deepEqual(ids(visible), ["a", "b", "c"]);
  assert.deepEqual(hidden, []);
});

test("equally used workspaces keep creation order so rows do not swap around", () => {
  const list = [workspace("first", 0), workspace("second", 0), workspace("third", 0)];
  const { visible } = orderWorkspaces(list, { now: NOW, activeId: "first" });
  assert.deepEqual(ids(visible), ["first", "second", "third"]);
});

test("ordering leaves the stored array untouched", () => {
  const list = [workspace("a", 2), workspace("b", 0)];
  orderWorkspaces(list, { now: NOW, activeId: "b" });
  assert.deepEqual(ids(list), ["a", "b"]);
});

test("the five most recent workspaces never sink, even when they are old", () => {
  // Six workspaces, all idle for more than a week: the newest five stay put.
  const list = Array.from({ length: VISIBLE_LIMIT + 1 }, (_, index) => workspace(`w${index}`, 8 + index));
  const { visible, hidden } = orderWorkspaces(list, { now: NOW });
  assert.deepEqual(ids(visible), ["w0", "w1", "w2", "w3", "w4"]);
  assert.deepEqual(ids(hidden), ["w5"]);
});

test("an idle workspace keeps its place when it is still one of the recent five", () => {
  const list = Array.from({ length: 3 }, (_, index) => workspace(`w${index}`, 30 + index));
  const { visible, hidden } = orderWorkspaces(list, { now: NOW });
  assert.deepEqual(ids(visible), ["w0", "w1", "w2"]);
  assert.deepEqual(hidden, []);
});

test("the idle boundary is exact: just under stays visible, exactly at it sinks", () => {
  const recent = Array.from({ length: VISIBLE_LIMIT }, (_, index) => workspace(`r${index}`, index * 0.5));
  const fresh = orderWorkspaces([...recent, { ...workspace("edge", 0), lastUsedAt: NOW - AUTO_HIDE_IDLE_MS + 1 }], { now: NOW });
  assert.deepEqual(ids(fresh.hidden), []);
  const stale = orderWorkspaces([...recent, { ...workspace("edge", 0), lastUsedAt: NOW - AUTO_HIDE_IDLE_MS }], { now: NOW });
  assert.deepEqual(ids(stale.hidden), ["edge"]);
});

test("the active workspace is never hidden, however stale it is", () => {
  const list = Array.from({ length: VISIBLE_LIMIT + 2 }, (_, index) => workspace(`w${index}`, 9 + index));
  const { visible, hidden } = orderWorkspaces(list, { now: NOW, activeId: "w6" });
  // w5 is the only stale workspace outside the recent five and the active one.
  assert.deepEqual(ids(hidden), ["w5"]);
  assert.ok(ids(visible).includes("w6"));
});

test("a workspace expanded by hand is exempt from the idle rule", () => {
  const list = Array.from({ length: VISIBLE_LIMIT + 1 }, (_, index) => workspace(`w${index}`, 8 + index));
  list[VISIBLE_LIMIT] = { ...list[VISIBLE_LIMIT], keepVisible: true };
  const { visible, hidden } = orderWorkspaces(list, { now: NOW });
  assert.deepEqual(hidden, []);
  assert.ok(ids(visible).includes(`w${VISIBLE_LIMIT}`));
});

test("a manual hide sinks a workspace even when it is recent", () => {
  const list = [workspace("a", 0, { hidden: true }), workspace("b", 1)];
  const { visible, hidden } = orderWorkspaces(list, { now: NOW, activeId: "b" });
  assert.deepEqual(ids(visible), ["b"]);
  assert.deepEqual(ids(hidden), ["a"]);
});

test("automatic hiding never empties the sidebar, but manual hiding may", () => {
  // Five recent workspaces were collapsed by hand and the only remaining one is
  // stale: the rule must pull it back so the sidebar is not empty.
  const recentHidden = Array.from({ length: VISIBLE_LIMIT }, (_, index) => workspace(`manual${index}`, index, { hidden: true }));
  const staleAuto = workspace("auto", 20);
  const rescued = orderWorkspaces([...recentHidden, staleAuto], { now: NOW });
  assert.deepEqual(ids(rescued.visible), ["auto"]);
  assert.equal(rescued.hidden.length, VISIBLE_LIMIT);
  // Hands-off: the user collapsed everything, so the list is genuinely empty
  // and only the dropdown can bring one back.
  const collapsed = [...recentHidden, { ...staleAuto, hidden: true }];
  assert.deepEqual(orderWorkspaces(collapsed, { now: NOW }).visible, []);
});

test("using a workspace clears a manual hide without moving the row", () => {
  const list = [workspace("a", 30, { hidden: true }), workspace("b", 1)];
  const next = recordWorkspaceUse(list, "a", NOW);
  assert.equal(next.find((item) => item.id === "a").hidden, undefined);
  const { visible, hidden } = orderWorkspaces(next, { now: NOW, activeId: "a" });
  assert.deepEqual(ids(visible), ["a", "b"]);
  assert.deepEqual(hidden, []);
});

test("hide and show set exactly one explicit flag", () => {
  const list = [workspace("a", 0)];
  const hidden = hideWorkspace(list, "a")[0];
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.keepVisible, false);
  const shown = showWorkspace(hideWorkspace(list, "a"), "a")[0];
  assert.equal(shown.hidden, false);
  assert.equal(shown.keepVisible, true);
  // A pinned workspace sinks again once the user collapses it by hand.
  const collapsed = hideWorkspace([shown], "a");
  assert.deepEqual(ids(orderWorkspaces(collapsed, { now: NOW }).hidden), ["a"]);
});

test("workspaces saved before usage tracking existed are not all collapsed", () => {
  // Legacy state has no lastUsedAt at all. The renderer seeds them at load; the
  // rule itself must still be idempotent for a single unknown workspace.
  const legacy = [{ id: "old", name: "old", terminalIds: [] }];
  assert.deepEqual(ids(orderWorkspaces(legacy, { now: NOW }).visible), ["old"]);
});

test("a terminal maps back to the workspace that owns it", () => {
  const list = [workspace("a", 30), { ...workspace("b", 1), terminalIds: ["t1", "t2"] }];
  assert.equal(workspaceForTerminal(list, "t2"), "b");
  assert.equal(workspaceForTerminal(list, "missing"), undefined);
  assert.equal(workspaceForTerminal(undefined, "t1"), undefined);
  assert.equal(workspaceForTerminal([{ id: "broken", name: "broken" }], "t1"), undefined);
});

test("recent use never moves a workspace ahead of older creation rows", () => {
  const list = [workspace("old", 30), workspace("new", 0.1), workspace("middle", 2)];
  const { visible } = orderWorkspaces(list, { now: NOW, activeId: "new" });
  assert.deepEqual(ids(visible), ["old", "new", "middle"]);
});

test("idle workspaces sink while the remaining rows keep creation order", () => {
  const list = [workspace("fresh", 0), ...Array.from({ length: VISIBLE_LIMIT }, (_, index) => workspace(`old${index}`, 8 + index))];
  // The live recent five are fresh + old0..old3; old4 is stale and sinks.
  const { visible, hidden } = orderWorkspaces(list, { now: NOW });
  assert.deepEqual(ids(hidden), ["old4"]);
  assert.deepEqual(ids(visible), ["fresh", "old0", "old1", "old2", "old3"]);
});
