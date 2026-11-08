// Shared state.json sanitization for the main process. Kept as CJS so tests
// can require it directly and scripts/copy-runtime.mjs can ship it.

function defaultState() {
  return { schemaVersion: 1, workspaces: [{ id: "default", name: "默认工作区", terminalIds: [] }], terminals: [], tasks: [] };
}

const AGENT_TYPES = new Set(["generic", "opencode", "codex", "claude", "pi"]);
const AGENT_STATES = new Set(["working", "completed-unseen", "ready", "awaiting-input", "error", "stopped"]);
const SHELL_TYPES = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "/bin/bash", "/bin/zsh"]);
const TASK_STATES = new Set(["working", "completed", "awaiting-input", "interrupted", "error", "cancelled"]);
const RECOVERY_STATES = new Set(["none", "interrupted", "resumable", "recovering", "recovered", "unsupported"]);
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_CWD_LENGTH = 32760;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_RESUME_ERROR_LENGTH = 500;
const MAX_TASK_BATCH_ID_LENGTH = 128;

function validId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

// Structural validation so a corrupted or hand-edited state.json cannot crash
// the renderer at hydration. Invalid entries are dropped rather than fatal.
function sanitizeState(parsed) {
  if (!parsed || typeof parsed !== "object") return defaultState();
  if (parsed.schemaVersion !== 1) return defaultState();
  const terminals = [];
  const terminalIds = new Set();
  for (const terminal of Array.isArray(parsed.terminals) ? parsed.terminals : []) {
    if (!terminal || !validId(terminal.id) || terminalIds.has(terminal.id)) continue;
    const title = cleanText(terminal.title, MAX_TITLE_LENGTH);
    const cwd = cleanText(terminal.cwd, MAX_CWD_LENGTH);
    if (!title || !cwd || !AGENT_TYPES.has(terminal.agentType)) continue;
    if (terminal.state !== undefined && !AGENT_STATES.has(terminal.state)) continue;
    if (terminal.shell !== undefined && !SHELL_TYPES.has(terminal.shell)) continue;
    if (terminal.lastSessionId !== undefined && !(typeof terminal.lastSessionId === "string" && terminal.lastSessionId.length > 0 && terminal.lastSessionId.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(terminal.lastSessionId))) continue;
    if (terminal.resumeAvailable !== undefined && typeof terminal.resumeAvailable !== "boolean") continue;
    if (terminal.recoveryState !== undefined && !RECOVERY_STATES.has(terminal.recoveryState)) continue;
    if (terminal.resumeError !== undefined && typeof terminal.resumeError !== "string") continue;
    terminalIds.add(terminal.id);
    terminals.push({
      id: terminal.id,
      title,
      cwd,
      agentType: terminal.agentType,
      state: AGENT_STATES.has(terminal.state) ? terminal.state : "ready",
      alive: false,
      lastActivityAt: Number.isFinite(terminal.lastActivityAt) ? Math.max(0, Math.round(terminal.lastActivityAt)) : 0,
      ...(SHELL_TYPES.has(terminal.shell) ? { shell: terminal.shell } : {}),
      ...(typeof terminal.titlePinned === "boolean" ? { titlePinned: terminal.titlePinned } : {}),
      ...(typeof terminal.lastSessionId === "string" ? { lastSessionId: terminal.lastSessionId.slice(0, MAX_SESSION_ID_LENGTH) } : {}),
      ...(typeof terminal.resumeAvailable === "boolean" ? { resumeAvailable: terminal.resumeAvailable } : {}),
      ...(RECOVERY_STATES.has(terminal.recoveryState) ? { recoveryState: terminal.recoveryState } : {}),
      ...(typeof terminal.resumeError === "string" && terminal.resumeError.trim() ? { resumeError: terminal.resumeError.trim().slice(0, MAX_RESUME_ERROR_LENGTH) } : {}),
    });
  }
  const knownIds = new Set(terminals.map((terminal) => terminal.id));
  const workspaces = [];
  const workspaceIds = new Set();
  const assignedTerminalIds = new Set();
  for (const workspace of Array.isArray(parsed.workspaces) ? parsed.workspaces : []) {
    if (!workspace || !validId(workspace.id) || workspaceIds.has(workspace.id) || !Array.isArray(workspace.terminalIds)) continue;
    const name = cleanText(workspace.name, MAX_TITLE_LENGTH) || `工作区 ${workspaces.length + 1}`;
    const workspaceTerminalIds = workspace.terminalIds.filter((id) => validId(id) && knownIds.has(id) && !assignedTerminalIds.has(id));
    workspaceTerminalIds.forEach((id) => assignedTerminalIds.add(id));
    workspaceIds.add(workspace.id);
    const next = { id: workspace.id, name, terminalIds: workspaceTerminalIds };
    const cwd = cleanText(workspace.cwd, MAX_CWD_LENGTH);
    if (cwd) next.cwd = cwd;
    if (workspace.namePinned === true) next.namePinned = true;
    workspaces.push(next);
  }
  const tasks = Array.isArray(parsed.tasks)
    ? parsed.tasks.filter((task) => Boolean(task)
      && validId(task.id)
      && typeof task.terminalId === "string" && knownIds.has(task.terminalId)
      && Number.isFinite(task.startedAt) && TASK_STATES.has(task.state))
      .slice(-1000)
      .map((task) => ({
        id: task.id,
        terminalId: task.terminalId,
        startedAt: Math.round(task.startedAt),
        ...(Number.isFinite(task.finishedAt) ? { finishedAt: Math.max(Math.round(task.startedAt), Math.round(task.finishedAt)) } : {}),
        state: task.state,
        ...(typeof task.prompt === "string" && task.prompt.trim() ? { prompt: task.prompt.trim().slice(0, 500) } : {}),
        ...(typeof task.summary === "string" && task.summary.trim() ? { summary: task.summary.trim().slice(0, 500) } : {}),
        ...(typeof task.error === "string" && task.error.trim() ? { error: task.error.trim().slice(0, 500) } : {}),
        ...(RECOVERY_STATES.has(task.recoveryState) ? { recoveryState: task.recoveryState } : {}),
        ...(typeof task.batchId === "string" && validId(task.batchId) ? { batchId: task.batchId.slice(0, MAX_TASK_BATCH_ID_LENGTH) } : {}),
        ...(typeof task.retestOf === "string" && validId(task.retestOf) ? { retestOf: task.retestOf } : {}),
        ...(Number.isInteger(task.attempt) && task.attempt > 0 && task.attempt <= 100 ? { attempt: task.attempt } : {}),
      }))
    : [];
  const knownWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const activeWorkspaceId = typeof parsed.activeWorkspaceId === "string" && knownWorkspaceIds.has(parsed.activeWorkspaceId)
    ? parsed.activeWorkspaceId
    : workspaces[0]?.id;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const activeTerminalId = typeof parsed.activeTerminalId === "string"
    && knownIds.has(parsed.activeTerminalId)
    && (!activeWorkspace || activeWorkspace.terminalIds.includes(parsed.activeTerminalId))
    ? parsed.activeTerminalId
    : activeWorkspace?.terminalIds[0] || terminals[0]?.id;
  const result = { schemaVersion: 1, workspaces, terminals, tasks, activeTerminalId };
  if (activeWorkspaceId !== undefined) result.activeWorkspaceId = activeWorkspaceId;
  if (SHELL_TYPES.has(parsed.defaultShell)) result.defaultShell = parsed.defaultShell;
  if (Number.isFinite(parsed.sidebarWidth)) result.sidebarWidth = Math.min(460, Math.max(220, Math.round(parsed.sidebarWidth)));
  if (parsed.windowBounds && typeof parsed.windowBounds === "object") {
    const width = Number.isFinite(parsed.windowBounds.width) ? Math.round(parsed.windowBounds.width) : 1280;
    const height = Number.isFinite(parsed.windowBounds.height) ? Math.round(parsed.windowBounds.height) : 820;
    const windowBounds = { width: Math.min(3840, Math.max(900, width)), height: Math.min(2160, Math.max(560, height)) };
    if (Number.isFinite(parsed.windowBounds.x)) windowBounds.x = Math.round(parsed.windowBounds.x);
    if (Number.isFinite(parsed.windowBounds.y)) windowBounds.y = Math.round(parsed.windowBounds.y);
    if (parsed.windowBounds.isMaximized === true) windowBounds.isMaximized = true;
    result.windowBounds = windowBounds;
  }
  return result;
}

module.exports = { sanitizeState, defaultState, AGENT_TYPES, AGENT_STATES, SHELL_TYPES, TASK_STATES, RECOVERY_STATES };
