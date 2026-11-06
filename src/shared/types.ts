export type AgentType = "generic" | "opencode" | "codex" | "claude";
export type AgentState = "working" | "completed-unseen" | "ready" | "awaiting-input" | "error" | "stopped";
export type ShellType = "cmd.exe" | "powershell.exe" | "pwsh.exe" | "/bin/bash";

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
  cwd: string;
  shell?: ShellType;
  agentType: AgentType;
  state: AgentState;
  alive: boolean;
  lastActivityAt: number;
  lastOutputSummary?: string;
}

export interface Workspace {
  id: string;
  name: string;
  terminalIds: string[];
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

export interface PtyOutputEvent {
  type: "pty:output";
  terminalId: string;
  data: string;
  sequence: number;
  replay: boolean;
  /** Sanitized single-line activity excerpt, safe to render in the UI. */
  summary?: string;
  at: number;
}

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

export interface PersistedState { schemaVersion: 1; workspaces: Workspace[]; terminals: TerminalInstance[]; activeTerminalId?: string; activeWorkspaceId?: string; defaultShell?: ShellType; sidebarWidth?: number; windowBounds?: WindowBounds; }

