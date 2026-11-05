export type AgentType = "generic" | "opencode" | "codex" | "claude";
export type AgentState = "working" | "completed-unseen" | "ready" | "awaiting-input" | "error" | "stopped";

export interface TerminalInstance {
  id: string;
  title: string;
  cwd: string;
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
  source: "output" | "hook" | "osc" | "user" | "process";
  summary?: string;
  at: number;
}

export interface PtyOutputEvent {
  type: "pty:output";
  terminalId: string;
  data: string;
  sequence: number;
  replay: boolean;
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
  type: "pty:host-exit" | "pty:host-disconnected";
  code?: number;
  signal?: string;
  message?: string;
  at: number;
}

export interface PersistedState { schemaVersion: 1; workspaces: Workspace[]; terminals: TerminalInstance[]; activeTerminalId?: string; }

