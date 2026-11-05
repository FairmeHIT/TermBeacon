// Shared state.json sanitization for the main process. Kept as CJS so tests
// can require it directly and scripts/copy-runtime.mjs can ship it.

function defaultState() {
  return { schemaVersion: 1, workspaces: [{ id: "default", name: "默认工作区", terminalIds: [] }], terminals: [] };
}

const AGENT_TYPES = new Set(["generic", "opencode", "codex", "claude"]);
const AGENT_STATES = new Set(["working", "completed-unseen", "ready", "awaiting-input", "error", "stopped"]);

// Structural validation so a corrupted or hand-edited state.json cannot crash
// the renderer at hydration. Invalid entries are dropped rather than fatal.
function sanitizeState(parsed) {
  if (!parsed || typeof parsed !== "object") return defaultState();
  if (parsed.schemaVersion !== 1) return defaultState();
  const workspaces = Array.isArray(parsed.workspaces)
    ? parsed.workspaces.filter((workspace) =>
      Boolean(workspace) && typeof workspace.id === "string" && typeof workspace.name === "string" && Array.isArray(workspace.terminalIds))
    : [];
  const terminals = Array.isArray(parsed.terminals)
    ? parsed.terminals.filter((terminal) =>
      Boolean(terminal) && typeof terminal.id === "string" && typeof terminal.title === "string"
        && typeof terminal.cwd === "string" && AGENT_TYPES.has(terminal.agentType)
        && (terminal.state === undefined || AGENT_STATES.has(terminal.state)))
    : [];
  const knownIds = new Set(terminals.map((terminal) => terminal.id));
  const sanitizedWorkspaces = workspaces.map((workspace) => ({
    ...workspace,
    terminalIds: (workspace.terminalIds || []).filter((id) => knownIds.has(id)),
  }));
  const activeTerminalId = typeof parsed.activeTerminalId === "string" && knownIds.has(parsed.activeTerminalId)
    ? parsed.activeTerminalId
    : terminals[0]?.id;
  const knownWorkspaceIds = new Set(sanitizedWorkspaces.map((workspace) => workspace.id));
  const activeWorkspaceId = typeof parsed.activeWorkspaceId === "string" && knownWorkspaceIds.has(parsed.activeWorkspaceId)
    ? parsed.activeWorkspaceId
    : sanitizedWorkspaces[0]?.id;
  const result = { schemaVersion: 1, workspaces: sanitizedWorkspaces, terminals, activeTerminalId };
  if (activeWorkspaceId !== undefined) result.activeWorkspaceId = activeWorkspaceId;
  return result;
}

module.exports = { sanitizeState, defaultState, AGENT_TYPES, AGENT_STATES };
