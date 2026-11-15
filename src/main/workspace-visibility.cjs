// Sidebar ordering and auto-collapse for workspaces.
//
// The stored array stays in creation order: renaming, deleting and
// lastActiveTerminalId never have to reason about a list that rearranges
// itself. Ordering and the visible/hidden split are derived at render time
// from each workspace's last usage, so one rule feeds both "frequently used
// floats up" and "unused sinks into the hidden group".

// A workspace only leaves the sidebar when it is both old and no longer part of
// the handful the user rotates through. Either condition alone is too eager:
// a busy week away from one project must not bury it, and a brand-new empty
// workspace must not push an old favourite out.
const AUTO_HIDE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const VISIBLE_LIMIT = 5;

function usedAt(workspace) {
  return Number.isSafeInteger(workspace?.lastUsedAt) && workspace.lastUsedAt >= 0 ? workspace.lastUsedAt : 0;
}

function orderWorkspaces(workspaces, { now = Date.now(), activeId } = {}) {
  const list = Array.isArray(workspaces) ? workspaces : [];
  // Rank once by recency, keeping creation order as the tie-break so equally
  // old workspaces never trade places between renders.
  const ranked = list
    .map((workspace, index) => ({ workspace, index }))
    .sort((left, right) => usedAt(right.workspace) - usedAt(left.workspace) || left.index - right.index);
  const rank = new Map(ranked.map((entry, index) => [entry.workspace.id, index]));
  const visible = [];
  const hidden = [];
  for (const { workspace } of ranked) {
    const idle = now - usedAt(workspace) >= AUTO_HIDE_IDLE_MS;
    const recent = (rank.get(workspace.id) ?? 0) < VISIBLE_LIMIT;
    // The workspace in front must never disappear: hiding it would leave the
    // sidebar pointing at a terminal list nobody can see.
    if (workspace.id === activeId || workspace.keepVisible) visible.push(workspace);
    else if (workspace.hidden || (idle && !recent)) hidden.push(workspace);
    else visible.push(workspace);
  }
  // Automatic hiding must never empty the sidebar. A manual hide may: the
  // dropdown still lists everything, so the user can always bring one back.
  if (visible.length === 0) {
    const rescue = hidden.findIndex((workspace) => !workspace.hidden);
    if (rescue >= 0) visible.push(...hidden.splice(rescue, 1));
  }
  return { visible, hidden };
}

// Opening a workspace, creating one, or working through one of its terminals is
// what "using" it means. An explicit hide is cleared because the user just
// asked to work in it again.
function recordWorkspaceUse(workspaces, id, at) {
  return (Array.isArray(workspaces) ? workspaces : []).map((workspace) => {
    if (workspace.id !== id) return workspace;
    const { hidden, ...rest } = workspace;
    return { ...rest, lastUsedAt: at };
  });
}

// The workspace a terminal belongs to, if any. Working inside a workspace
// through its terminals counts as using it, so the caller can feed this back
// into recordWorkspaceUse without duplicating the lookup.
function workspaceForTerminal(workspaces, terminalId) {
  return (Array.isArray(workspaces) ? workspaces : [])
    .find((workspace) => Array.isArray(workspace?.terminalIds) && workspace.terminalIds.includes(terminalId))?.id;
}

function hideWorkspace(workspaces, id) {
  return (Array.isArray(workspaces) ? workspaces : []).map((workspace) => workspace.id === id
    ? { ...workspace, hidden: true, keepVisible: false }
    : workspace);
}

// Unhiding by hand is a request to keep it around, so it also opts out of the
// idle rule; otherwise a stale workspace would sink again the moment it is
// expanded.
function showWorkspace(workspaces, id) {
  return (Array.isArray(workspaces) ? workspaces : []).map((workspace) => workspace.id === id
    ? { ...workspace, hidden: false, keepVisible: true }
    : workspace);
}

module.exports = { AUTO_HIDE_IDLE_MS, VISIBLE_LIMIT, orderWorkspaces, recordWorkspaceUse, workspaceForTerminal, hideWorkspace, showWorkspace };
