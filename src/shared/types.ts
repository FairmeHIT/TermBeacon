export type AgentType = "generic" | "opencode" | "codex" | "claude" | "pi";
export type AgentCliId = Exclude<AgentType, "generic">;
export type CliAction = "install" | "update" | "reinstall" | "integrate" | "use-system" | "use-managed" | "rollback";
export interface CliProgress { id: AgentCliId; action: CliAction; phase: string; message: string; at: number; }
export interface AgentCliInfo {
  id: AgentCliId;
  name: string;
  command: string;
  package: string;
  description: string;
  docs: string;
  signal: string;
  installed: boolean;
  executable?: string;
  version?: string;
  error?: string;
  source: "system" | "managed" | "missing";
  externalPaths: string[];
  managedInstalled: boolean;
  managedVersion?: string;
  previousVersion?: string;
  integration: { state: "inferred" | "configured" | "outdated" | "missing" | "error"; label: string; detail: string; path?: string };
  operation?: CliProgress;
}
export interface CliScan {
  agents: AgentCliInfo[];
  runtime: { ready: boolean; node?: string; npm?: string; nodeVersion?: string; message: string };
  root: string;
  checkedAt: number;
}
export interface CliPlan { token: string; id: AgentCliId; action: CliAction; title: string; packageVersion?: string; command?: string; changes: string[]; target: string; expiresAt: number; }
export type AgentState = "working" | "completed-unseen" | "ready" | "awaiting-input" | "error" | "stopped";
export type RecoveryState = "none" | "interrupted" | "resumable" | "recovering" | "recovered" | "unsupported";
export type TaskState = "working" | "completed" | "awaiting-input" | "interrupted" | "error" | "cancelled";
export type ShellType = "cmd.exe" | "powershell.exe" | "pwsh.exe" | "/bin/bash" | "/bin/zsh";

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export interface TerminalInstance {
  id: string;
  title: string;
  /** True after the user explicitly renamed the terminal. */
  titlePinned?: boolean;
  cwd: string;
  shell?: ShellType;
  agentType: AgentType;
  state: AgentState;
  alive: boolean;
  lastActivityAt: number;
  lastOutputSummary?: string;
  lastSessionId?: string;
  resumeAvailable?: boolean;
  recoveryState?: RecoveryState;
  resumeError?: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** True after the user renamed the workspace by hand. */
  namePinned?: boolean;
  /** Local folder this workspace is anchored to; new terminals start here. */
  cwd?: string;
  terminalIds: string[];
}

export interface TaskRecord {
  id: string;
  terminalId: string;
  startedAt: number;
  finishedAt?: number;
  state: TaskState;
  prompt?: string;
  summary?: string;
  error?: string;
  recoveryState?: RecoveryState;
  /** Batch that created this attempt, when it was started by a retest. */
  batchId?: string;
  /** Original task this attempt was created from. */
  retestOf?: string;
  /** One-based attempt number for the original task. */
  attempt?: number;
}

export interface PlatformInfo {
  platform: string;
  isWindows: boolean;
  isMac: boolean;
  shell: string;
  cwd: string;
}

export interface StateUpdateEvent {
  type: "state:update";
  terminalId: string;
  previous: AgentState;
  current: AgentState;
  confidence: number;
  source: "output" | "hook" | "osc" | "title" | "user" | "process";
  summary?: string;
  at: number;
}

/**
 * Live detector state for one terminal, published by the PTY host whenever a
 * client attaches. The host outlives renderer reloads, so this is the only way
 * a reconnecting UI can learn what the sidebar should show.
 */
export interface StateSnapshotEntry {
  terminalId: string;
  state: AgentState;
  summary?: string;
  at: number;
}

export interface StateSnapshotEvent {
  type: "state:snapshot";
  entries: StateSnapshotEntry[];
  at: number;
}

export interface PtyOutputEvent {
  type: "pty:output";
  terminalId: string;
  data: string;
  sequence: number;
  streamId?: string;
  flowId?: string;
  deliveryId?: number;
  replay: boolean;
  at: number;
}

export type PtyOutputReceipt = Pick<PtyOutputEvent, "terminalId" | "sequence" | "streamId" | "flowId" | "deliveryId">;

export interface PtyTitleEvent {
  type: "pty:title";
  terminalId: string;
  title: string;
  at: number;
}

export interface PtyCwdEvent {
  type: "pty:cwd";
  terminalId: string;
  cwd: string;
  at: number;
}

export interface PtyAgentEvent {
  type: "pty:agent";
  terminalId: string;
  agentType: AgentType;
  at: number;
}

export interface PtySessionEvent {
  type: "session:update";
  terminalId: string;
  sessionId: string;
  at: number;
}

export interface PtyExitEvent {
  type: "pty:exit";
  terminalId: string;
  exitCode?: number;
  reason: "natural" | "user-kill" | "host-error" | "unknown";
  at: number;
}

export interface PtyErrorEvent {
  type: "pty:error";
  operation: string;
  requestId?: string;
  terminalId?: string;
  code: string;
  message: string;
  at: number;
}

export interface PtyHostExitEvent {
  type: "pty:host-exit" | "pty:host-disconnected" | "pty:host-stopped";
  code?: number;
  signal?: string;
  message?: string;
  at: number;
}

export interface PtyHostReadyEvent {
  type: "pty:host-ready";
  flowId?: string;
  at: number;
}

export interface PersistedState { schemaVersion: 1; workspaces: Workspace[]; terminals: TerminalInstance[]; tasks?: TaskRecord[]; activeTerminalId?: string; activeWorkspaceId?: string; defaultShell?: ShellType; sidebarWidth?: number; windowBounds?: WindowBounds; }

