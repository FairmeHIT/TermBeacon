import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentState, AgentType, PersistedState, PlatformInfo, PtyAgentEvent, PtyCwdEvent, PtyErrorEvent, PtyExitEvent, PtyHostExitEvent, PtyHostReadyEvent, PtyOutputEvent, PtyOutputReceipt, PtySessionEvent, PtyTitleEvent, RecoveryState, ShellType, StateSnapshotEvent, StateUpdateEvent, TaskRecord, TaskState, TerminalInstance, Workspace } from "../shared/types";
import SettingsPage from "./SettingsPage";
import { describeSettingsUpdate, readSettingsLocale, saveSettingsLocale, settingsText, type SettingsLocale } from "./settings-i18n";
import type { AgentCliId, CliAction, CliPlan, CliScan, CliProgress } from "../shared/types";
import launchUtils from "../main/agent-launch.cjs";
import taskHistoryUtils from "../main/task-history.cjs";
import { normalizePiCursorOutput, splitScreenOutput } from "./terminal-screen";
import "./styles.css";

const { cleanTaskPrompt, applyTaskEvent, settleTask: settleTaskRecords, markInterrupted, restoreAttachedTasks, restoredTerminalRecovery } = taskHistoryUtils as {
  cleanTaskPrompt: (value: string) => string | undefined;
  applyTaskEvent: (items: TaskRecord[], event: StateUpdateEvent, prompt?: string) => TaskRecord[];
  settleTask: (items: TaskRecord[], terminalId: string, state: Extract<TaskState, "completed" | "error" | "cancelled">, at: number, detail?: string) => TaskRecord[];
  markInterrupted: (items: TaskRecord[], at: number, detail?: string) => TaskRecord[];
  restoreAttachedTasks: (items: TaskRecord[], terminalId: string, previouslyActive: Map<string, TaskRecord>) => TaskRecord[];
  restoredTerminalRecovery: (terminal: TerminalInstance, existing: boolean) => RecoveryState;
};
const { isAgentLaunchInput, withOpenCodeStandalone } = launchUtils as {
  isAgentLaunchInput: (value: string | undefined, agentType: AgentType) => boolean;
  withOpenCodeStandalone: (data: string, candidate: string | undefined, agentType: AgentType) => string;
};

// Mirrors the payload the main process sends on update:event and returns from
// update:check / update:state.
type UpdateStatus = { type: string; version?: string; percent?: number; message?: string };
declare global {
  interface Window {
    termbeacon: {
      loadState(): Promise<PersistedState>;
      saveState(state: PersistedState): Promise<boolean>;
      scanCli(): Promise<CliScan>;
      planCli(request: { id: AgentCliId; action: CliAction }): Promise<CliPlan>;
      executeCli(request: { token: string }): Promise<unknown>;
      getCliLaunchSpec(request: { id: AgentCliId; shell: ShellType }): Promise<{ command: string }>;
      openCliDocs(id: AgentCliId): Promise<void>;
      onCliProgress(listener: (event: CliProgress) => void): () => void;
      getPlatformInfo(): Promise<PlatformInfo>;
      readClipboardText(): Promise<string>;
      confirm(request: { message: string; detail?: string; okLabel?: string; cancelLabel?: string }): Promise<boolean>;
      pickCwd(): Promise<string | null>;
      loadHistory(terminalId: string): Promise<string>;
      appendHistory(terminalId: string, data: string): Promise<boolean>;
      removeHistory(terminalId: string): Promise<boolean>;
      installUpdate(): Promise<boolean>;
      getUpdateState(): Promise<{ status: UpdateStatus; currentVersion: string; packaged: boolean; configured: boolean }>;
      checkForUpdates(): Promise<UpdateStatus>;
      getResumeSpec(request: { agentType?: AgentType; sessionId?: string; cwd?: string; shell?: ShellType }): Promise<{ supported: boolean; command?: string; mode?: string; reason?: string }>;
      restartHost(request?: { force: boolean }): Promise<boolean>;
      createTerminal(request: unknown): Promise<unknown>;
      write(request: unknown): void;
      launch(request: unknown): void;
      resize(request: unknown): void;
      replay(request: unknown): void;
      acknowledgeOutput(event: PtyOutputReceipt, consumed?: boolean): void;
      forget(terminalId: string): void;
      kill(request: unknown): void;
      viewed(terminalId: string): void;
      rebuildDetector(request: unknown): void;
      onOutput(listener: (event: PtyOutputEvent) => void): () => void;
      onState(listener: (event: StateUpdateEvent) => void): () => void;
      onSnapshot(listener: (event: StateSnapshotEvent) => void): () => void;
      onExit(listener: (event: PtyExitEvent) => void): () => void;
      onError(listener: (event: PtyErrorEvent) => void): () => void;
      onHost(listener: (event: PtyHostExitEvent | PtyHostReadyEvent) => void): () => void;
      onTitle(listener: (event: PtyTitleEvent) => void): () => void;
      onCwd(listener: (event: PtyCwdEvent) => void): () => void;
      onAgent(listener: (event: PtyAgentEvent) => void): () => void;
      onSession(listener: (event: PtySessionEvent) => void): () => void;
      onUpdate(listener: (event: UpdateStatus) => void): () => void;
    };
  }
}

const stateLabel: Record<AgentState, string> = {
  working: "工作中",
  "completed-unseen": "已完成",
  ready: "就绪",
  "awaiting-input": "等待输入",
  error: "异常",
  stopped: "已停止",
};

const stateClass: Record<AgentState, string> = {
  working: "working",
  "completed-unseen": "completed",
  ready: "ready",
  "awaiting-input": "awaiting",
  error: "error",
  stopped: "stopped",
};

const agentLabel: Record<AgentType, string> = {
  generic: "",
  opencode: "opencode",
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
};

const shellLabel: Record<string, string> = {
  "cmd.exe": "命令提示符",
  "powershell.exe": "PowerShell",
  "pwsh.exe": "PowerShell 7",
  "/bin/bash": "Bash",
  "/bin/zsh": "Zsh",
};

function terminalCliLabel(terminal: TerminalInstance, translate: (source: string) => string): string {
  const source = agentLabel[terminal.agentType] || shellLabel[terminal.shell || DEFAULT_SHELL] || terminal.shell || "Shell";
  return translate(source);
}

function terminalStateLabel(terminal: TerminalInstance, translate: (source: string) => string): string {
  if (terminal.recoveryState === "recovering") return translate("正在恢复");
  if (terminal.recoveryState === "resumable" || terminal.recoveryState === "interrupted") return translate("可恢复");
  if (terminal.recoveryState === "unsupported") return translate("无法恢复");
  return translate(stateLabel[terminal.state]);
}

function isClaudeStatusTitle(title: string): boolean {
  return /^(?:[◐◑✳]\s*)?Claude Code$/i.test(title.trim());
}

function isGeneratedTerminalTitle(title: string): boolean {
  return /^(?:终端|Terminal)\s+\d+$/i.test(title.trim()) || isClaudeStatusTitle(title);
}

type Theme = "dark" | "light";

const terminalThemes: Record<Theme, { background: string; foreground: string; cursor: string }> = {
  dark: { background: "#101215", foreground: "#d7dce3", cursor: "#8ab8ed" },
  light: { background: "#ffffff", foreground: "#29313b", cursor: "#2563a8" },
};

declare global {
  interface Navigator {
    userAgentData?: { platform: string };
  }
}

function rendererPlatformFallback(): PlatformInfo {
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
  const isWindows = /win/i.test(platform);
  const isMac = /mac/i.test(platform);
  return {
    platform: isWindows ? "win32" : isMac ? "darwin" : "linux",
    isWindows,
    isMac,
    shell: isWindows ? "powershell.exe" : isMac ? "/bin/zsh" : "/bin/bash",
    cwd: isWindows ? "C:\\" : "/",
  };
}

const FALLBACK_PLATFORM = rendererPlatformFallback();
const IS_WINDOWS = FALLBACK_PLATFORM.isWindows;

const DEFAULT_SHELL: ShellType = FALLBACK_PLATFORM.shell as ShellType;
const SHELL_OPTIONS: Array<{ value: ShellType; label: string }> = IS_WINDOWS
  ? [{ value: "cmd.exe", label: "命令提示符" }, { value: "powershell.exe", label: "Windows PowerShell" }, { value: "pwsh.exe", label: "PowerShell 7" }]
  : FALLBACK_PLATFORM.isMac
    ? [{ value: "/bin/zsh", label: "Zsh" }, { value: "/bin/bash", label: "Bash" }]
    : [{ value: "/bin/bash", label: "Bash" }];
const DEFAULT_CWD = FALLBACK_PLATFORM.cwd;

function isSupportedShell(value: unknown): value is ShellType {
  return SHELL_OPTIONS.some((option) => option.value === value) || value === DEFAULT_SHELL;
}

function isValidCwd(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && (IS_WINDOWS
    ? /^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path)
    : path.startsWith("/"));
}

function newTerminal(index: number, shell: ShellType = DEFAULT_SHELL, cwd: string = DEFAULT_CWD): TerminalInstance {
  return {
    id: crypto.randomUUID(),
    title: `终端 ${index}`,
    titlePinned: false,
    cwd,
    shell,
    agentType: "generic",
    state: "ready",
    alive: false,
    lastActivityAt: Date.now(),
  };
}

const MAX_TITLE_LENGTH = 60;

function normalizeTitleInput(value: string): string {
  return value.trim().slice(0, MAX_TITLE_LENGTH);
}

// "D:\a\b\my-project" -> "my-project"; "/home/user/my-project" -> "my-project".
const PATH_SEPARATORS = /[\\/]+/;
function folderNameFromPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const last = trimmed.split(PATH_SEPARATORS).filter(Boolean).pop();
  return last ? last.slice(0, MAX_TITLE_LENGTH) : "";
}

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect className="brand-mark-tile" x=".5" y=".5" width="31" height="31" rx="9.5" />
    <path className="brand-mark-signal" d="M16 10a6 6 0 0 1 6 6M16 5a11 11 0 0 1 11 11" />
    <circle className="brand-mark-core" cx="16" cy="19" r="4" />
    <path className="brand-mark-base" d="M12 26h8" />
  </svg>;
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "dark"
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.7A8.8 8.8 0 0 1 8.3 3.6a8.8 8.8 0 1 0 12.1 12.1Z" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6"} /></svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 4v16" />
    <path d={collapsed ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"} />
  </svg>;
}

// Mirrors src/main/title-utils.cjs (kept inline here because the renderer
// bundle cannot reliably import CommonJS modules from the main process tree).
function EditableTitle({ title, onCommit, renameHint = "双击重命名" }: { title: string; onCommit: (next: string) => void; renameHint?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);
  if (!editing) return <strong title={renameHint} onDoubleClick={() => { setDraft(title); setEditing(true); }}>{title}</strong>;
  function commit() {
    setEditing(false);
    const next = normalizeTitleInput(draft);
    if (next) onCommit(next);
  }
  return <input ref={inputRef} className="title-input" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") commit(); else if (event.key === "Escape") setEditing(false); }} />;
}

function App() {
  const [terminals, setTerminals] = useState<TerminalInstance[]>(() => [newTerminal(1)]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => [{ id: "default", name: "默认工作区", terminalIds: [] }]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("default");
  const [activeId, setActiveId] = useState<string>(() => terminals[0].id);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo>(FALLBACK_PLATFORM);
  const [defaultShell, setDefaultShell] = useState<ShellType>(DEFAULT_SHELL);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("termbeacon-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLocale, setSettingsLocale] = useState<SettingsLocale>(() => readSettingsLocale(window.localStorage));
  useEffect(() => { saveSettingsLocale(window.localStorage, settingsLocale); }, [settingsLocale]);
  const t = (source: string, values?: Record<string, string | number>) => settingsText(settingsLocale, source, values);
  useEffect(() => { document.documentElement.lang = settingsLocale === "en" ? "en" : "zh-CN"; }, [settingsLocale]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem("termbeacon-sidebar-collapsed") === "true");
  const [hostDown, setHostDown] = useState(false);
  const [hostMessage, setHostMessage] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [updateState, setUpdateState] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [appPackaged, setAppPackaged] = useState(true);
  const [updateBusy, setUpdateBusy] = useState(false);
  const pendingCliLaunch = useRef(new Map<string, string>());
  const terminalNodes = useRef(new Map<string, HTMLDivElement>());
  const terminalViews = useRef(new Map<string, Terminal>());
  const fitAddons = useRef(new Map<string, FitAddon>());
  const consumedLocal = useRef(new Map<string, number>());
  const outputStreams = useRef(new Map<string, string>());
  const activityAt = useRef(new Map<string, number>());
  const terminalStage = useRef<HTMLDivElement | null>(null);
  const workspaceStrip = useRef<HTMLDivElement | null>(null);
  const pendingHistory = useRef(new Map<string, { chunks: string[]; start: number; length: number }>());
  const alternateScreenByTerminal = useRef(new Map<string, boolean>());
  const pendingOpenCodeWheel = useRef(new Map<string, { data: string; frame: number }>());
  const taskTitles = useRef(new Map<string, string>());
  const historyFlushTimer = useRef<number | null>(null);
  const lastSavedState = useRef("");
  const restoredTerminalIds = useRef(new Set<string>());
  const previouslyActiveTasks = useRef(new Map<string, TaskRecord>());
  const agentTypeByTerminal = useRef(new Map<string, AgentType>());
  const lastInput = useRef(new Map<string, string>());
  const inputBuffers = useRef(new Map<string, string>());
  // Terminal titles the user renamed by hand. OSC 0/2 title reports from the
  // shell/agent must not overwrite a name the user chose on purpose.
  const pinnedTitles = useRef(new Set<string>());
  // Live detector state published by the PTY host on every (re)attach. The host
  // owns the PTY, so its state survives renderer reloads; without it the sidebar
  // can only guess, and it used to guess "就绪" forever.
  const hostStates = useRef(new Map<string, { state: AgentState; summary?: string; at: number }>());
  // Timestamp of the last state this renderer applied per terminal, so an older
  // snapshot can never overwrite a newer transition that already arrived.
  const lastStateAt = useRef(new Map<string, number>());

  // The PTY host owns task detection and keeps running across renderer reloads,
  // so its snapshot is the authority for terminals the UI has not observed
  // itself. Anything newer that this renderer already applied wins.
  function applyHostStates() {
    if (hostStates.current.size === 0) return;
    setTerminals((items) => {
      let changed = false;
      const next = items.map((item) => {
        const snapshot = hostStates.current.get(item.id);
        if (!snapshot) return item;
        if (snapshot.at < (lastStateAt.current.get(item.id) ?? 0)) return item;
        if (item.state === snapshot.state && snapshot.summary === undefined) return item;
        changed = true;
        lastStateAt.current.set(item.id, Math.max(snapshot.at, lastStateAt.current.get(item.id) ?? 0));
        return { ...item, state: snapshot.state, lastOutputSummary: snapshot.summary ?? item.lastOutputSummary };
      });
      return changed ? next : items;
    });
  }

  const active = useMemo(() => terminals.find((terminal) => terminal.id === activeId) ?? terminals[0], [activeId, terminals]);
  const activeWorkspace = useMemo(() => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0], [workspaces, activeWorkspaceId]);
  const workspaceTerminals = useMemo(() => terminals.filter((terminal) => activeWorkspace?.terminalIds.includes(terminal.id)), [terminals, activeWorkspace]);

  function displayTerminalTitle(terminal: TerminalInstance): string {
    if (terminal.titlePinned) return terminal.title;
    const match = /^(?:终端|Terminal)\s+(\d+)$/i.exec(terminal.title.trim());
    return match ? t("终端 {index}", { index: match[1] }) : terminal.title;
  }

  function displayWorkspaceName(workspace: Workspace): string {
    if (workspace.namePinned) return workspace.name;
    if (workspace.name === "默认工作区") return t("默认工作区");
    const match = /^工作区\s+(\d+)$/.exec(workspace.name.trim());
    return match ? t("工作区 {index}", { index: match[1] }) : workspace.name;
  }

  function flushPendingHistory() {
    const pending = new Map(pendingHistory.current);
    pendingHistory.current.clear();
    pending.forEach(({ chunks, start }, terminalId) => {
      if (chunks.length > start) {
        void window.termbeacon.appendHistory(terminalId, chunks.slice(start).join("")).catch((error) => {
          console.error(`[history] save failed for ${terminalId}`, error);
        });
      }
    });
  }

  function isWheelMouseReport(data: string) {
    // SGR mouse mode encodes wheel-up/down as buttons 64/65. OpenCode emits
    // these reports while its alternate-screen renderer is active.
    return /^\x1b\[<6[45];\d+;\d+[mM]$/.test(data);
  }

  function writeOpenCodeInput(terminalId: string, data: string, agentType?: AgentType) {
    const detected = agentType ?? agentTypeByTerminal.current.get(terminalId);
    if (detected !== "opencode" || !isWheelMouseReport(data)) {
      window.termbeacon.write({ terminalId, data });
      return;
    }
    const previous = pendingOpenCodeWheel.current.get(terminalId);
    if (previous) {
      // Keep the newest wheel direction while the current frame is waiting.
      previous.data = data;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const pending = pendingOpenCodeWheel.current.get(terminalId);
      pendingOpenCodeWheel.current.delete(terminalId);
      if (pending) window.termbeacon.write({ terminalId, data: pending.data });
    });
    pendingOpenCodeWheel.current.set(terminalId, { data, frame });
  }

  useEffect(() => {
    void Promise.all([window.termbeacon.getPlatformInfo(), window.termbeacon.loadState()]).then(([info, state]) => {
      setPlatformInfo(info);
      const runtimeDefaultShell = isSupportedShell(info.shell) ? info.shell : DEFAULT_SHELL;
      const restoredDefaultShell = isSupportedShell(state.defaultShell) ? state.defaultShell : runtimeDefaultShell;
      setDefaultShell(restoredDefaultShell);
      const restoredAt = Date.now();
      restoredTerminalIds.current = new Set(state.terminals.map((terminal) => terminal.id));
      previouslyActiveTasks.current = new Map((state.tasks ?? [])
        .filter((task) => task.state === "working" || task.state === "awaiting-input")
        .map((task) => [task.id, task]));
      setTasks(markInterrupted(state.tasks ?? [], restoredAt));
      if (typeof state.sidebarWidth === "number") setSidebarWidth(state.sidebarWidth);
      const freshTerminal = state.terminals.length === 0 ? newTerminal(1, restoredDefaultShell, info.cwd) : null;
      if (state.terminals.length > 0) {
        const restoredTerminals = state.terminals.map((terminal) => {
          const interrupted = terminal.state === "working" || terminal.state === "awaiting-input";
          const recoveryState: RecoveryState = interrupted
            ? "resumable"
            : (terminal.recoveryState || "none");
          return ({
          ...terminal,
          // Preserve the detected agent and session metadata so a new shell
          // can explicitly resume the CLI session after a machine restart.
          agentType: terminal.agentType,
          shell: isSupportedShell(terminal.shell) ? terminal.shell : restoredDefaultShell,
          titlePinned: terminal.titlePinned ?? !isGeneratedTerminalTitle(terminal.title),
          alive: false,
          state: interrupted ? "stopped" as AgentState : terminal.state,
          resumeAvailable: terminal.agentType !== "generic" ? true : terminal.resumeAvailable,
          recoveryState,
          ...(interrupted ? { resumeError: undefined } : {}),
        });
        });
        pinnedTitles.current = new Set(restoredTerminals.filter((terminal) => terminal.titlePinned).map((terminal) => terminal.id));
        setTerminals(restoredTerminals);
      } else {
        setTerminals(freshTerminal ? [freshTerminal] : []);
      }
      // A workspace title mirrors its folder name until the user renames it.
      const restored = state.workspaces.length > 0
        ? state.workspaces.map((workspace) => {
          if (workspace.namePinned || !workspace.cwd) return workspace;
          const folderName = folderNameFromPath(workspace.cwd);
          return folderName ? { ...workspace, name: folderName } : workspace;
        })
        : [{ id: "default", name: "默认工作区", terminalIds: state.terminals.map((terminal) => terminal.id) }];
      const restoredActiveWorkspaceId = state.activeWorkspaceId && restored.some((workspace) => workspace.id === state.activeWorkspaceId)
        ? state.activeWorkspaceId
        : restored[0].id;
      if (state.terminals.length === 0) {
        // Seed the fresh active workspace with the initial terminal so the
        // sidebar is never empty on first launch.
        const freshTerminalId = freshTerminal?.id;
        setWorkspaces(restored.map((workspace) => workspace.id === restoredActiveWorkspaceId
          ? { ...workspace, terminalIds: freshTerminalId ? [freshTerminalId] : [] }
          : workspace));
        // activeId still points at the throwaway terminal from useState. Leaving
        // it stale made "delete the only terminal" skip the replacement branch.
        if (freshTerminalId) setActiveId(freshTerminalId);
      } else {
        setWorkspaces(restored);
        const workspaceTerminalIds = restored.find((workspace) => workspace.id === restoredActiveWorkspaceId)?.terminalIds ?? [];
        const fallbackId = workspaceTerminalIds.find((id) => state.terminals.some((terminal) => terminal.id === id));
        const savedActiveId = state.activeTerminalId && workspaceTerminalIds.includes(state.activeTerminalId)
          ? state.activeTerminalId
          : undefined;
        setActiveId(savedActiveId ?? fallbackId ?? state.terminals[0].id);
      }
      setActiveWorkspaceId(restoredActiveWorkspaceId);
      setHydrated(true);
    }).catch((error) => {
      console.error("[startup] failed to restore state", error);
      const fallback = newTerminal(1, DEFAULT_SHELL, FALLBACK_PLATFORM.cwd);
      setPlatformInfo(FALLBACK_PLATFORM);
      setDefaultShell(DEFAULT_SHELL);
      setTasks([]);
      setTerminals([fallback]);
      setWorkspaces([{ id: "default", name: "默认工作区", terminalIds: [fallback.id] }]);
      setActiveWorkspaceId("default");
      setActiveId(fallback.id);
      setHydrated(true);
    });
    const disposeOutput = window.termbeacon.onOutput((event) => {
      const view = terminalViews.current.get(event.terminalId);
      // Return only the receipt across contextBridge, not a second copy of
      // the terminal payload, and don't retain that payload in write callbacks.
      const receipt = { terminalId: event.terminalId, sequence: event.sequence, streamId: event.streamId, flowId: event.flowId, deliveryId: event.deliveryId };
      if (!view) window.termbeacon.acknowledgeOutput(receipt, false);
      if (event.streamId && outputStreams.current.get(event.terminalId) !== event.streamId) {
        outputStreams.current.set(event.terminalId, event.streamId);
        consumedLocal.current.delete(event.terminalId);
      }
      if (view && event.replay && consumedLocal.current.has(event.terminalId) && (consumedLocal.current.get(event.terminalId) ?? 0) >= event.sequence) {
        window.termbeacon.acknowledgeOutput(receipt, false);
        return;
      }
      if (view && Number.isInteger(event.sequence)) {
        const seen = consumedLocal.current.get(event.terminalId) ?? 0;
        if (event.sequence <= seen && !event.replay) {
          window.termbeacon.acknowledgeOutput(receipt, false);
          return;
        }
        consumedLocal.current.set(event.terminalId, Math.max(seen, event.sequence));
      }
      const initialAlternate = alternateScreenByTerminal.current.get(event.terminalId) ?? false;
      const screen = splitScreenOutput(event.data, initialAlternate);
      alternateScreenByTerminal.current.set(event.terminalId, screen.alternate);
      const agentType = agentTypeByTerminal.current.get(event.terminalId);
      const renderData = agentType === "pi"
        ? normalizePiCursorOutput(event.data, initialAlternate).normalData
        : event.data;
      view?.write(renderData, () => window.termbeacon.acknowledgeOutput(receipt));
      activityAt.current.set(event.terminalId, event.at);
      if (!event.replay && screen.normalData) {
        const pending = pendingHistory.current.get(event.terminalId) || { chunks: [], start: 0, length: 0 };
        pending.chunks.push(screen.normalData);
        pending.length += screen.normalData.length;
        // Only a bounded tail is persisted. Limit batches before the timer
        // fires too, including when background-window timers are throttled.
        while (pending.length > 250_000) {
          const first = pending.chunks[pending.start];
          const discard = Math.min(first.length, pending.length - 250_000);
          if (discard === first.length) {
            pending.chunks[pending.start++] = "";
            pending.length -= first.length;
          } else {
            const tail = first.slice(discard).replace(/^[\uDC00-\uDFFF]/, "");
            pending.chunks[pending.start] = tail;
            pending.length -= first.length - tail.length;
          }
        }
        if (pending.start > 64 && pending.start * 2 >= pending.chunks.length) {
          pending.chunks = pending.chunks.slice(pending.start);
          pending.start = 0;
        }
        pendingHistory.current.set(event.terminalId, pending);
        if (historyFlushTimer.current === null) {
          historyFlushTimer.current = window.setTimeout(() => {
            historyFlushTimer.current = null;
            flushPendingHistory();
          }, 750);
        }
      }
    });
    const disposeSnapshot = window.termbeacon.onSnapshot((event) => {
      const receivedAt = typeof event.at === "number" ? event.at : Date.now();
      // The snapshot is the complete list of terminals the host still owns, so
      // it replaces the map: a terminal missing from it has no live PTY and its
      // old entry must not be replayed over local state later.
      const next = new Map<string, { state: AgentState; summary?: string; at: number }>();
      for (const entry of event.entries ?? []) {
        next.set(entry.terminalId, {
          state: entry.state,
          summary: entry.summary,
          at: typeof entry.at === "number" ? entry.at : receivedAt,
        });
      }
      hostStates.current = next;
      applyHostStates();
    });
    const disposeState = window.termbeacon.onState((event) => {
      const prompt = lastInput.current.get(event.terminalId);
      lastStateAt.current.set(event.terminalId, typeof event.at === "number" ? event.at : Date.now());
      if (event.current === "working" && prompt) syncClaudeTaskTitle(event.terminalId, prompt);
      setTerminals((items) => items.map((item) => item.id === event.terminalId ? { ...item, state: event.current, lastOutputSummary: event.summary ?? item.lastOutputSummary, alive: event.current !== "stopped", recoveryState: item.recoveryState === "recovering" ? "recovered" : item.recoveryState } : item));
      setTasks((items) => applyTaskEvent(items, event, prompt));
    });
    const disposeExit = window.termbeacon.onExit((event) => {
      setTerminals((items) => items.map((item) => item.id === event.terminalId ? { ...item, alive: false, state: event.reason === "user-kill" || event.exitCode === 0 ? "stopped" : "error" } : item));
      setTasks((items) => settleTaskRecords(items, event.terminalId, event.reason === "user-kill" || event.exitCode === 0 ? "cancelled" : "error", event.at, event.reason));
    });
    const disposeError = window.termbeacon.onError((event) => {
      if (!event.terminalId) return;
      const terminalId = event.terminalId;
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, alive: false, state: "error", recoveryState: item.recoveryState === "recovering" ? "unsupported" : item.recoveryState, resumeError: item.recoveryState === "recovering" ? String(event.message || "恢复命令失败").slice(-500) : item.resumeError, lastOutputSummary: String(event.message || "PTY request failed").slice(-90) }
        : item));
      setTasks((items) => settleTaskRecords(items, terminalId, "error", event.at, event.message));
    });
    const disposeHost = window.termbeacon.onHost((event) => {
      if (event.type === "pty:host-ready") {
        setHostDown(false);
        setHostMessage("");
        return;
      }
      if (event.type !== "pty:host-exit" && event.type !== "pty:host-disconnected" && event.type !== "pty:host-stopped") return;
      setHostDown(true);
      setHostMessage(event.message || "PTY Host 已断开");
      setTasks((items) => items.map((task) => task.state === "working" || task.state === "awaiting-input"
        ? { ...task, state: "error", finishedAt: event.at, error: event.message || "PTY Host 已断开", summary: event.message || "PTY Host 已断开" }
        : task));
      setTerminals((items) => items.map((item) => item.alive
        ? { ...item, alive: false, state: "error", lastOutputSummary: event.message || "PTY Host 已断开" }
        : item));
    });
    const disposeTitle = window.termbeacon.onTitle((event) => {
      if (pinnedTitles.current.has(event.terminalId)) return;
      // Claude Code uses OSC 0 for a spinner/status title, not the task name.
      // Keep the submitted task title in the sidebar instead of replacing it
      // with the static "Claude Code" label on every redraw.
      if (isClaudeStatusTitle(event.title)) return;
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, title: event.title }
        : item));
    });
    const disposeCwd = window.termbeacon.onCwd((event) => {
      setTerminals((items) => items.map((item) => item.id === event.terminalId && item.cwd !== event.cwd
        ? { ...item, cwd: event.cwd }
        : item));
    });
    // Agent type is identified by the PTY host from the CLI's own banner; the
    // UI only stores it so the sidebar can show which agent is running.
    const disposeAgent = window.termbeacon.onAgent((event) => {
      agentTypeByTerminal.current.set(event.terminalId, event.agentType);
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, agentType: event.agentType, resumeAvailable: event.agentType !== "generic", recoveryState: item.recoveryState === "recovering" ? "recovered" : item.recoveryState }
        : item));
      setTasks((items) => items.map((task) => task.terminalId === event.terminalId && task.recoveryState === "recovering"
        ? { ...task, recoveryState: "recovered" }
        : task));
    });
    const disposeSession = window.termbeacon.onSession((event) => {
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, lastSessionId: event.sessionId, resumeAvailable: true, recoveryState: item.recoveryState === "recovering" ? "recovered" : item.recoveryState, resumeError: undefined }
        : item));
      setTasks((items) => items.map((task) => task.terminalId === event.terminalId && (task.recoveryState === "resumable" || task.recoveryState === "recovering")
        ? { ...task, recoveryState: "recovered" }
        : task));
    });
    const disposeUpdate = window.termbeacon.onUpdate((event) => setUpdateState(event));
    // The automatic check runs before this renderer mounts, so read the last
    // known result instead of assuming idle (a download may already be running).
    void window.termbeacon.getUpdateState().then((info) => {
      setAppVersion(info.currentVersion);
      setAppPackaged(info.packaged);
      if (info.status.type !== "idle") setUpdateState(info.status);
    }).catch(() => undefined);
    const flushOnVisibilityChange = () => { if (document.visibilityState === "hidden") flushPendingHistory(); };
    document.addEventListener("visibilitychange", flushOnVisibilityChange);
    window.addEventListener("beforeunload", flushPendingHistory);
    return () => {
      disposeOutput(); disposeState(); disposeSnapshot(); disposeExit(); disposeError(); disposeHost(); disposeTitle(); disposeCwd(); disposeAgent(); disposeSession(); disposeUpdate();
      document.removeEventListener("visibilitychange", flushOnVisibilityChange);
      window.removeEventListener("beforeunload", flushPendingHistory);
      flushPendingHistory();
      if (historyFlushTimer.current !== null) {
        window.clearTimeout(historyFlushTimer.current);
        historyFlushTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  // The workspace list scrolls vertically, so a workspace that was just created
  // or selected can sit outside the visible area. Keep the active one in view
  // without letting the browser scroll the window itself.
  useEffect(() => {
    const strip = workspaceStrip.current;
    const item = strip?.querySelector<HTMLElement>(".workspace-item.active");
    if (!strip || !item) return;
    const itemBox = item.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    if (itemBox.top < stripBox.top) {
      strip.scrollTop -= stripBox.top - itemBox.top;
    } else if (itemBox.bottom > stripBox.bottom) {
      strip.scrollTop += itemBox.bottom - stripBox.bottom;
    }
  }, [activeWorkspaceId, workspaces.length, sidebarWidth]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("termbeacon-theme", theme);
    terminalViews.current.forEach((term) => { term.options.theme = terminalThemes[theme]; });
  }, [theme]);

  useEffect(() => {
    if (!hydrated) return;
    terminals.forEach((terminal) => {
      if (terminalViews.current.has(terminal.id)) return;
      agentTypeByTerminal.current.set(terminal.id, terminal.agentType);
      const term = new Terminal({
        // TUI applications use LF together with cursor movement sequences.
        // Converting every LF to CRLF shifts the cursor and corrupts redraws.
        convertEol: false,
        cursorBlink: true,
        fontFamily: "Cascadia Mono, Consolas, monospace",
        fontSize: 14,
        scrollback: 20000,
        theme: terminalThemes[theme],
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const key = event.key.toLowerCase();
        const pasteShortcut = key === "v"
          ? (event.ctrlKey || event.metaKey) && !event.altKey
          : key === "insert" && event.shiftKey && !event.altKey && !event.metaKey;
        if (!pasteShortcut) return true;
        event.preventDefault();
        event.stopPropagation();
        void window.termbeacon.readClipboardText().then((text) => {
          if (typeof text === "string" && text) term.paste(text);
        }).catch(() => undefined);
        return false;
      });
      term.onData((data) => {
        const buffer = inputBuffers.current.get(terminal.id) || "";
        const submitted = data.includes("\r") || data.includes("\n");
        let candidate: string | undefined;
        if (submitted) {
          candidate = cleanTaskPrompt(`${buffer}${data.replace(/[\r\n].*$/, "")}`);
          inputBuffers.current.delete(terminal.id);
        } else {
          if (/^\x1b/.test(data)) {
            writeOpenCodeInput(terminal.id, data, agentTypeByTerminal.current.get(terminal.id) ?? terminal.agentType);
            return;
          }
          let nextBuffer = buffer;
          if (data.includes("\b") || data.includes("\x7f")) {
            const count = (data.match(/[\b\x7f]/g) || []).length;
            nextBuffer = `${buffer.slice(0, Math.max(0, buffer.length - count))}${cleanTaskPrompt(data.replace(/[\b\x7f]/g, "")) || ""}`;
          } else {
            nextBuffer = `${buffer}${cleanTaskPrompt(data) || ""}`;
          }
          if (nextBuffer) inputBuffers.current.set(terminal.id, nextBuffer.slice(-500));
          candidate = nextBuffer;
        }
        const launch = isAgentLaunchInput(candidate, agentTypeByTerminal.current.get(terminal.id) ?? terminal.agentType);
        if (submitted && candidate && !launch) lastInput.current.set(terminal.id, candidate);
        const launchData = launch
          ? withOpenCodeStandalone(data, candidate, agentTypeByTerminal.current.get(terminal.id) ?? terminal.agentType)
          : data;
        const request = { terminalId: terminal.id, data: launchData };
        if (launch) window.termbeacon.launch(request);
        else window.termbeacon.write(request);
      });
      terminalViews.current.set(terminal.id, term);
      fitAddons.current.set(terminal.id, fit);
      const node = terminalNodes.current.get(terminal.id);
      if (node) {
        term.open(node);
        // A replacement terminal can be created in the same React commit as
        // the delete action. Focus again after xterm has opened its textarea;
        // the earlier delete-handler focus request may have run too soon.
        if (terminal.id === activeId && !settingsOpen) {
          term.focus();
          requestAnimationFrame(() => {
            if (terminalViews.current.get(terminal.id) === term && node.style.display !== "none") term.focus();
          });
        }
      }
      // Fit before creating the PTY so the shell and any TUI app launched in
      // it starts with the real cols/rows. A hardcoded 120x32 leaves a window
      // where the app paints with wrong coordinates until the first resize.
      try { fit.fit(); } catch { /* container may not be visible yet */ }
      const cols = term.cols > 1 ? term.cols : 120;
      const rows = term.rows > 1 ? term.rows : 32;
      sentSizes.current.set(terminal.id, `${cols}x${rows}`);
      void (async () => {
        try {
          const history = await window.termbeacon.loadHistory(terminal.id);
          if (terminalViews.current.get(terminal.id) !== term) return;
          if (history && terminalViews.current.get(terminal.id) === term) {
            const replay = splitScreenOutput(history);
            term.write(replay.normalData);
          }
          const result = await window.termbeacon.createTerminal({
            terminalId: terminal.id,
            title: terminal.title,
            cwd: terminal.cwd,
            shell: terminal.shell || defaultShell,
            args: [],
            cols,
            rows,
            agentType: terminal.agentType,
          });
          const pendingCommand = pendingCliLaunch.current.get(terminal.id);
          if (pendingCommand) {
            pendingCliLaunch.current.delete(terminal.id);
            window.termbeacon.launch({ terminalId: terminal.id, data: `${pendingCommand}\r` });
          }
          const existing = Boolean((result as { existing?: boolean } | undefined)?.existing);
          const restored = restoredTerminalIds.current.delete(terminal.id);
          // Disk history excludes alternate-screen output, so it cannot tell
          // us which screen an attached process is currently displaying.
          alternateScreenByTerminal.current.set(terminal.id, false);
          // Attaching to a live PTY must not invent a healthy state: keep what
          // the host reported in the snapshot, and only a brand-new PTY starts
          // at 就绪. This is the path that used to pin the sidebar to 就绪.
          const snapshot = hostStates.current.get(terminal.id);
          setTerminals((items) => items.map((item) => item.id === terminal.id
            ? {
              ...item,
              alive: true,
              state: snapshot ? snapshot.state : existing ? item.state : "ready",
              recoveryState: restored ? restoredTerminalRecovery(item, existing) : item.recoveryState,
              resumeError: undefined,
            }
            : item));
          if (existing) {
            // Restore the screen mode from the host buffer, then force a full
            // TUI repaint even when that bounded buffer starts mid-screen.
            if (terminal.agentType !== "generic") {
              consumedLocal.current.delete(terminal.id);
              window.termbeacon.replay({ terminalId: terminal.id, fromSequence: 0 });
            }
            const temporaryCols = cols > 2 ? cols - 1 : cols + 1;
            applyPtySize(terminal.id, temporaryCols, rows);
            const pendingResize = resizeTimers.current.get(terminal.id);
            if (pendingResize) window.clearTimeout(pendingResize);
            const resizeTimer = window.setTimeout(() => {
              resizeTimers.current.delete(terminal.id);
              if (terminalViews.current.get(terminal.id) === term) applyPtySize(terminal.id, term.cols, term.rows);
            }, 100);
            resizeTimers.current.set(terminal.id, resizeTimer);
            setTasks((items) => restoreAttachedTasks(items, terminal.id, previouslyActiveTasks.current));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setTerminals((items) => items.map((item) => item.id === terminal.id
            ? { ...item, alive: false, state: "error", lastOutputSummary: message.slice(-90) }
            : item));
        }
      })();
    });
  }, [terminals, hydrated, platformInfo.shell, activeId, settingsOpen]);

  useEffect(() => {
    if (!hydrated) return;
    const handle = window.setTimeout(() => {
      const stableTerminals = terminals.map((terminal) => ({
        id: terminal.id,
        title: terminal.title,
        titlePinned: terminal.titlePinned === true,
        cwd: terminal.cwd,
        shell: terminal.shell || defaultShell,
        agentType: terminal.agentType,
        state: terminal.state,
        alive: false,
        lastActivityAt: activityAt.current.get(terminal.id) ?? terminal.lastActivityAt ?? 0,
        ...(terminal.lastSessionId ? { lastSessionId: terminal.lastSessionId } : {}),
        ...(terminal.resumeAvailable !== undefined ? { resumeAvailable: terminal.resumeAvailable } : {}),
        ...(terminal.recoveryState ? { recoveryState: terminal.recoveryState } : {}),
        ...(terminal.resumeError ? { resumeError: terminal.resumeError } : {}),
      }));
      const state: PersistedState = {
        schemaVersion: 1,
        workspaces,
        terminals: stableTerminals,
        activeTerminalId: activeId,
        activeWorkspaceId,
        tasks,
        defaultShell,
        sidebarWidth,
      };
      const serialized = JSON.stringify(state);
      if (serialized === lastSavedState.current) return;
      lastSavedState.current = serialized;
      void window.termbeacon.saveState(state).catch((error) => {
        console.error("[state] save failed", error);
      });
    }, 150);
    return () => window.clearTimeout(handle);
  }, [terminals, workspaces, activeId, activeWorkspaceId, tasks, defaultShell, sidebarWidth, hydrated]);

  useEffect(() => {
    terminalViews.current.forEach((term, id) => {
      const node = terminalNodes.current.get(id);
      if (node) node.style.display = id === activeId ? "block" : "none";
    });
    // Re-fit the freshly shown terminal: the container may have changed size
    // while it was hidden (display:none skips ResizeObserver events).
    requestAnimationFrame(() => schedulePtyFit(activeId, 0));
  }, [activeId]);

  useEffect(() => {
    if (!hydrated) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        schedulePtyFit(activeId);
      });
    };
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (observer && terminalStage.current) observer.observe(terminalStage.current);
    return () => {
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [activeId, hydrated]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettingsOpen(true); return; }
      if (settingsOpen) return;
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        addTerminal();
        return;
      }
      if (key === "w") {
        event.preventDefault();
        if (activeId) void removeTerminal(activeId);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (workspaceTerminals.length === 0) return;
        const index = workspaceTerminals.findIndex((terminal) => terminal.id === activeId);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = workspaceTerminals[(index + delta + workspaceTerminals.length) % workspaceTerminals.length];
        if (next) selectTerminal(next.id);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeId, workspaceTerminals, terminals, workspaces, activeWorkspaceId, settingsOpen]);

  // Last cols/rows actually sent to the PTY per terminal. xterm's local size
  // changes instantly on fit(), but the pty-side resize travels an async IPC
  // chain; sending only real changes keeps the TUI app's coordinate system in
  // sync with what xterm is rendering and avoids resize storms (sidebar drag
  // fires ResizeObserver every frame).
  const sentSizes = useRef(new Map<string, string>());
  // Pending debounced resize per terminal, so a burst of container resizes
  // collapses into one pty resize that lands after the final size is known.
  const resizeTimers = useRef(new Map<string, number>());

  function applyPtySize(id: string, cols: number, rows: number) {
    if (cols < 2 || rows < 2) return;
    const key = `${cols}x${rows}`;
    if (sentSizes.current.get(id) === key) return;
    sentSizes.current.set(id, key);
    window.termbeacon.resize({ terminalId: id, cols, rows });
  }

  function fitTerminal(id: string) {
    const fit = fitAddons.current.get(id);
    if (!fit) return;
    try {
      fit.fit();
      const term = terminalViews.current.get(id);
      if (term) applyPtySize(id, term.cols, term.rows);
    } catch { /* container may not be visible yet */ }
  }

  // Fit locally right away (so xterm's canvas matches the container) but
  // debounce the pty notification: during a window/sidebar resize the size
  // settles over several frames and only the final one should reach the app.
  function schedulePtyFit(id: string, delayMs = 50) {
    const term = terminalViews.current.get(id);
    if (!term) return;
    const existing = resizeTimers.current.get(id);
    if (existing) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
      resizeTimers.current.delete(id);
      fitTerminal(id);
    }, delayMs);
    resizeTimers.current.set(id, handle);
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(460, Math.max(220, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(next);
    };
    const stop = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function restartHost() {
    setHostMessage("正在重启 PTY Host…");
    void window.termbeacon.restartHost().then((ok) => {
      if (!ok) setHostMessage("PTY Host 重启失败");
    });
  }

  // Manual check from the settings page. The main process keeps a single
  // in-flight check, so a double click just returns the current status.
  async function checkForUpdates() {
    setUpdateBusy(true);
    setUpdateState({ type: "checking" });
    try {
      const status = await window.termbeacon.checkForUpdates();
      if (status) setUpdateState(status);
    } catch (error) {
      setUpdateState({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setUpdateBusy(false);
    }
  }

  const updateHint = describeSettingsUpdate(settingsLocale, updateState, appPackaged);

  function restartTerminal(id: string) {
    const terminal = terminals.find((item) => item.id === id);
    if (!terminal || terminal.alive) return;
    agentTypeByTerminal.current.set(id, terminal.agentType);
    const term = terminalViews.current.get(id);
    try { term?.reset(); } catch { /* view may already be gone */ }
    const cols = term && term.cols > 1 ? term.cols : 120;
    const rows = term && term.rows > 1 ? term.rows : 32;
    sentSizes.current.set(id, `${cols}x${rows}`);
    void window.termbeacon.createTerminal({
      terminalId: terminal.id,
      title: terminal.title,
      cwd: terminal.cwd,
      shell: terminal.shell || defaultShell,
      args: [],
      cols,
      rows,
      agentType: terminal.agentType,
    }).then(() => {
      setTerminals((items) => items.map((item) => item.id === id ? { ...item, alive: true, state: "ready", resumeError: undefined } : item));
      requestAnimationFrame(() => fitTerminal(id));
    }).catch((error: Error) => {
      setTerminals((items) => items.map((item) => item.id === id
        ? { ...item, alive: false, state: "error", lastOutputSummary: error.message.slice(-90) }
        : item));
    });
  }

  async function resumeTerminal(id: string) {
    const terminal = terminals.find((item) => item.id === id);
    if (!terminal || !terminal.alive || terminal.recoveryState === "recovering") return;
    let spec: { supported: boolean; command?: string; reason?: string };
    try {
      spec = await window.termbeacon.getResumeSpec({
        agentType: terminal.agentType,
        sessionId: terminal.lastSessionId,
        cwd: terminal.cwd,
        shell: terminal.shell || defaultShell,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTerminals((items) => items.map((item) => item.id === id
        ? { ...item, recoveryState: "unsupported", resumeAvailable: false, resumeError: message.slice(-500) }
        : item));
      return;
    }
    if (!spec.supported || !spec.command) {
      setTerminals((items) => items.map((item) => item.id === id
        ? { ...item, recoveryState: "unsupported", resumeAvailable: false, resumeError: spec.reason || "该 CLI 不支持会话恢复" }
        : item));
      return;
    }
    setTerminals((items) => items.map((item) => item.id === id
      ? { ...item, recoveryState: "recovering", resumeError: undefined }
      : item));
    setTasks((items) => items.map((task) => task.terminalId === id && task.state === "interrupted"
      ? { ...task, recoveryState: "recovering" }
      : task));
    window.termbeacon.launch({ terminalId: id, data: `${spec.command}\r` });
  }

  // The rename inputs are rendered inside the chip/terminal <button>, so the
  // double-click that opens one also reaches the button's onClick. Focusing the
  // terminal view on the next frame then blurred the fresh input, whose onBlur
  // commits and unmounts it -- rename looked impossible. Skip the steal while
  // a title input owns focus.
  function focusTerminalView(id: string) {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.classList.contains("title-input")) return;
      terminalViews.current.get(id)?.focus();
    });
  }

  function selectTerminal(id: string) {
    setSettingsOpen(false);
    setActiveId(id);
    window.termbeacon.viewed(id);
    setTerminals((items) => items.map((item) => item.id === id && item.state === "completed-unseen" ? { ...item, state: "ready" } : item));
    focusTerminalView(id);
  }

  async function launchCli(id: AgentCliId) {
    const spec = await window.termbeacon.getCliLaunchSpec({ id, shell: defaultShell });
    const terminal = newTerminal(terminals.length + 1, defaultShell, activeWorkspace?.cwd || DEFAULT_CWD);
    terminal.agentType = id;
    terminal.title = agentLabel[id];
    pendingCliLaunch.current.set(terminal.id, spec.command);
    setTerminals((items) => [...items, terminal]);
    setWorkspaces((items) => items.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, terminalIds: [...workspace.terminalIds, terminal.id] } : workspace));
    setActiveId(terminal.id);
    setSettingsOpen(false);
  }

  useEffect(() => {
    if (settingsOpen) terminalViews.current.get(activeId)?.blur();
    else requestAnimationFrame(() => { schedulePtyFit(activeId, 0); terminalViews.current.get(activeId)?.focus(); });
  }, [settingsOpen]);

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    window.localStorage.setItem("termbeacon-sidebar-collapsed", String(next));
    if (next) setSettingsOpen(false);
  }

  // Terminals created inside a workspace start in the workspace's folder.
  function addTerminal() {
    setSettingsOpen(false);
    const workspaceCwd = activeWorkspace?.cwd;
    const terminal = newTerminal(terminals.length + 1, defaultShell, workspaceCwd && isValidCwd(workspaceCwd) ? workspaceCwd : DEFAULT_CWD);
    setTerminals((items) => [...items, terminal]);
    setWorkspaces((items) => items.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, terminalIds: [...workspace.terminalIds, terminal.id] } : workspace));
    setActiveId(terminal.id);
  }

  async function removeTerminal(id: string) {
    const target = terminals.find((item) => item.id === id);
    if (!target) return;
    // A native message box instead of window.confirm: the built-in dialog never
    // restores the renderer's focus state on Windows, so the terminal would
    // silently swallow every keystroke until the user switched windows.
    const confirmed = await window.termbeacon.confirm({
      message: t("删除终端「{title}」？正在运行的进程会被停止。", { title: displayTerminalTitle(target) }),
      okLabel: t("删除"),
      cancelLabel: t("取消"),
    });
    if (!confirmed) return;
    window.termbeacon.forget(id);
    const view = terminalViews.current.get(id);
    if (view) {
      try { view.dispose(); } catch { /* view may already be disposed */ }
    }
    terminalViews.current.delete(id);
    fitAddons.current.delete(id);
    consumedLocal.current.delete(id);
    outputStreams.current.delete(id);
    activityAt.current.delete(id);
    terminalNodes.current.delete(id);
    pendingHistory.current.delete(id);
    alternateScreenByTerminal.current.delete(id);
    const pendingWheel = pendingOpenCodeWheel.current.get(id);
    if (pendingWheel) window.cancelAnimationFrame(pendingWheel.frame);
    pendingOpenCodeWheel.current.delete(id);
    taskTitles.current.delete(id);
    pendingCliLaunch.current.delete(id);
    agentTypeByTerminal.current.delete(id);
    lastInput.current.delete(id);
    inputBuffers.current.delete(id);
    sentSizes.current.delete(id);
    pinnedTitles.current.delete(id);
    const pendingResize = resizeTimers.current.get(id);
    if (pendingResize) window.clearTimeout(pendingResize);
    resizeTimers.current.delete(id);
    setTasks((items) => items.filter((task) => task.terminalId !== id));
    void window.termbeacon.removeHistory(id);
    const owner = workspaces.find((workspace) => workspace.terminalIds.includes(id));
    const remaining = owner ? owner.terminalIds.filter((terminalId) => terminalId !== id) : [];
    if (id === activeId && remaining.length === 0) {
      const replacementCwd = owner?.cwd && isValidCwd(owner.cwd) ? owner.cwd : DEFAULT_CWD;
      const replacement = newTerminal(terminals.length, defaultShell, replacementCwd);
      setTerminals((items) => [...items.filter((item) => item.id !== id), replacement]);
      setWorkspaces((items) => items.map((workspace) => workspace.id === owner?.id ? { ...workspace, terminalIds: [replacement.id] } : workspace));
      setActiveId(replacement.id);
      // The delete button keeps focus after the click. Restore focus to the
      // replacement xterm once React has mounted it so typing reaches the PTY.
      focusTerminalView(replacement.id);
      return;
    }
    const nextActiveId = id === activeId ? remaining[0] : activeId;
    if (nextActiveId) setActiveId(nextActiveId);
    setTerminals((items) => items.filter((item) => item.id !== id));
    setWorkspaces((items) => items.map((workspace) => workspace.id === owner?.id ? { ...workspace, terminalIds: remaining } : workspace));
    if (nextActiveId) focusTerminalView(nextActiveId);
  }

  function selectWorkspace(id: string) {
    setSettingsOpen(false);
    setActiveWorkspaceId(id);
    const nextTerminalId = workspaces.find((workspace) => workspace.id === id)?.terminalIds[0];
    if (nextTerminalId && terminals.some((terminal) => terminal.id === nextTerminalId)) {
      setActiveId(nextTerminalId);
      focusTerminalView(nextTerminalId);
    } else {
      const fallback = terminals.find((terminal) => workspaces.some((workspace) => workspace.id === id && workspace.terminalIds.includes(terminal.id)));
      if (fallback) setActiveId(fallback.id);
    }
  }

  // New workspaces are anchored to a local folder: the folder name becomes the
  // default title (until the user renames it) and new terminals start in it.
  async function addWorkspace() {
    let picked: string | null;
    try {
      picked = await window.termbeacon.pickCwd();
    } catch {
      return;
    }
    if (!isValidCwd(picked)) return;
    const folderName = folderNameFromPath(picked);
    const terminal = newTerminal(terminals.length + 1, defaultShell, picked);
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: folderName || `工作区 ${workspaces.length + 1}`,
      cwd: picked,
      terminalIds: [terminal.id],
    };
    setTerminals((items) => [...items, terminal]);
    setWorkspaces((items) => [...items, workspace]);
    setActiveWorkspaceId(workspace.id);
    setActiveId(terminal.id);
  }

  function renameWorkspace(id: string, name: string) {
    setWorkspaces((items) => items.map((workspace) => workspace.id === id ? { ...workspace, name, namePinned: true } : workspace));
  }

  async function removeWorkspace(id: string) {
    if (workspaces.length < 2) return;
    const target = workspaces.find((workspace) => workspace.id === id);
    if (!target) return;
    const directory = target.cwd ? t("目录：{path}", { path: target.cwd }) : "";
    const confirmed = await window.termbeacon.confirm({
      message: t("删除工作区「{name}」及其中的 {count} 个终端？", { name: displayWorkspaceName(target), count: target.terminalIds.length }),
      detail: directory || undefined,
      okLabel: t("删除"),
      cancelLabel: t("取消"),
    });
    if (!confirmed) return;
    target.terminalIds.forEach((terminalId) => {
      window.termbeacon.forget(terminalId);
    });
    const removedIds = new Set(target.terminalIds);
    removedIds.forEach((id) => pinnedTitles.current.delete(id));
    removedIds.forEach((terminalId) => {
      try { terminalViews.current.get(terminalId)?.dispose(); } catch { /* view may already be disposed */ }
      terminalViews.current.delete(terminalId);
      fitAddons.current.delete(terminalId);
      consumedLocal.current.delete(terminalId);
      outputStreams.current.delete(terminalId);
      activityAt.current.delete(terminalId);
      terminalNodes.current.delete(terminalId);
      pendingHistory.current.delete(terminalId);
      alternateScreenByTerminal.current.delete(terminalId);
      const pendingWheel = pendingOpenCodeWheel.current.get(terminalId);
      if (pendingWheel) window.cancelAnimationFrame(pendingWheel.frame);
      pendingOpenCodeWheel.current.delete(terminalId);
      taskTitles.current.delete(terminalId);
      agentTypeByTerminal.current.delete(terminalId);
      lastInput.current.delete(terminalId);
      inputBuffers.current.delete(terminalId);
      sentSizes.current.delete(terminalId);
      const pendingResize = resizeTimers.current.get(terminalId);
      if (pendingResize) window.clearTimeout(pendingResize);
      resizeTimers.current.delete(terminalId);
      void window.termbeacon.removeHistory(terminalId);
    });
    setTasks((items) => items.filter((task) => !removedIds.has(task.terminalId)));
    setTerminals((items) => items.filter((item) => !removedIds.has(item.id)));
    const remaining = workspaces.filter((workspace) => workspace.id !== id);
    setWorkspaces(remaining);
    if (id === activeWorkspaceId) {
      setActiveWorkspaceId(remaining[0].id);
      const nextTerminalId = remaining[0].terminalIds.find((terminalId) => !removedIds.has(terminalId));
      if (nextTerminalId) setActiveId(nextTerminalId);
    }
    if (removedIds.has(activeId)) {
      const nextTerminalId = remaining.flatMap((workspace) => workspace.terminalIds).find((terminalId) => !removedIds.has(terminalId));
      if (nextTerminalId) setActiveId(nextTerminalId);
    }
  }

  function renameTerminal(id: string, title: string) {
    pinnedTitles.current.add(id);
    taskTitles.current.delete(id);
    setTerminals((items) => items.map((item) => item.id === id ? { ...item, title, titlePinned: true } : item));
  }

  function syncClaudeTaskTitle(id: string, prompt: string) {
    if (pinnedTitles.current.has(id)) return;
    if (agentTypeByTerminal.current.get(id) !== "claude") return;
    const title = normalizeTitleInput(prompt);
    if (!title || taskTitles.current.get(id) === title) return;
    taskTitles.current.set(id, title);
    setTerminals((items) => items.map((item) => item.id === id && !item.titlePinned
      ? { ...item, title, titlePinned: false }
      : item));
  }

  return <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${settingsOpen ? "settings-mode" : ""}`}>
    <aside className="sidebar">
      {!sidebarCollapsed && <>
      <div className="brand-row"><div className="brand-lockup"><BrandMark /><div className="brand">TermBeacon</div></div></div>
      <section className="sidebar-section workspaces-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">{t("工作区")}</span>
          <button className="workspace-add" onClick={addWorkspace} title={t("添加工作区（选择本地文件夹）")} aria-label={t("添加工作区（选择本地文件夹）")}><PlusIcon /></button>
        </div>
        <div className="workspace-list" ref={workspaceStrip}>
          {workspaces.map((workspace) => <button key={workspace.id} className={`workspace-item ${workspace.id === activeWorkspaceId ? "active" : ""}`} onClick={() => selectWorkspace(workspace.id)} title={workspace.cwd ? `${displayWorkspaceName(workspace)} (${workspace.cwd})` : displayWorkspaceName(workspace)}>
            <span className="workspace-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
            </span>
            <span className="workspace-copy">
              <EditableTitle title={displayWorkspaceName(workspace)} renameHint={t("双击重命名")} onCommit={(next) => renameWorkspace(workspace.id, next)} />
              <small>{workspace.cwd || t("未设置目录")}</small>
            </span>
            {workspaces.length > 1 && <span className="workspace-remove" onClick={(event) => { event.stopPropagation(); void removeWorkspace(workspace.id); }} title={t("删除工作区「{name}」", { name: displayWorkspaceName(workspace) })} role="button" aria-label={t("删除工作区「{name}」", { name: displayWorkspaceName(workspace) })}>×</span>}
          </button>)}
        </div>
      </section>
      <section className="sidebar-section terminals-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">{t("终端")}</span>
          <button className="workspace-add" onClick={addTerminal} title={t("新建终端")} aria-label={t("新建终端")}><PlusIcon /></button>
        </div>
        <div className="terminal-list">
        {workspaceTerminals.map((terminal) => <button key={terminal.id} className={`terminal-item ${terminal.id === activeId ? "active" : ""}`} onClick={() => selectTerminal(terminal.id)}>
          <span className={`status-dot ${stateClass[terminal.state]}`} />
          <span className="terminal-copy"><EditableTitle title={displayTerminalTitle(terminal)} renameHint={t("双击重命名")} onCommit={(next) => renameTerminal(terminal.id, next)} /><small>{terminalCliLabel(terminal, t)} · {terminalStateLabel(terminal, t)}</small></span>
          {terminal.id === activeId && <span className="active-mark">●</span>}
          {terminal.alive && (terminal.recoveryState === "resumable" || terminal.recoveryState === "interrupted") && <span className="terminal-resume" role="button" onClick={(event) => { event.stopPropagation(); void resumeTerminal(terminal.id); }} title={t("恢复 CLI 会话")}>{t("恢复")}</span>}
          <span className="terminal-remove" onClick={(event) => { event.stopPropagation(); void removeTerminal(terminal.id); }} title={t("删除终端")}>×</span>
        </button>)}
        </div>
      </section>
      {hostDown && <div className="host-alert">
        <span>{hostMessage ? settingsText(settingsLocale, hostMessage) : t("PTY Host 已断开")}</span>
        <button onClick={restartHost}>{t("重启 PTY Host")}</button>
      </div>}
      <div className="sidebar-footer">
        <button className="sidebar-tool sidebar-toggle" onClick={toggleSidebar} title={t("隐藏工作栏")} aria-label={t("隐藏工作栏")}><SidebarToggleIcon collapsed={false} /></button>
        <button className={`sidebar-tool ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((open) => !open)} title={t("打开设置")} aria-label={t("打开设置")}><SettingsIcon /></button>
        <button className="sidebar-tool theme-tool" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} title={t(theme === "dark" ? "切换到浅色主题" : "切换到深色主题")} aria-label={t(theme === "dark" ? "切换到浅色主题" : "切换到深色主题")}><ThemeIcon theme={theme} /></button>
      </div>
      <div className="sidebar-resizer" onPointerDown={beginSidebarResize} title={t("拖动调整侧栏宽度")} />
      </>}
    </aside>
    {settingsOpen && <SettingsPage locale={settingsLocale} onLocale={setSettingsLocale} theme={theme} onTheme={setTheme} shell={defaultShell} shellOptions={SHELL_OPTIONS} onShell={setDefaultShell}
      version={appVersion} updateHint={updateHint} updateBusy={updateBusy || updateState?.type === "downloading"}
      updateDownloaded={updateState?.type === "downloaded" ? updateState.version || "新版本" : undefined}
      onCheckUpdate={() => void checkForUpdates()} onInstallUpdate={() => void window.termbeacon.installUpdate()}
      onRestartHost={async () => {
        const confirmed = await window.termbeacon.confirm({
          message: settingsText(settingsLocale, "重启终端服务将关闭所有终端进程，包括正在运行的 Agent。请先完成或保存任务。确定重启？"),
          okLabel: settingsText(settingsLocale, "重启服务"),
          cancelLabel: settingsText(settingsLocale, "取消"),
        });
        if (!confirmed) return;
        const ok = await window.termbeacon.restartHost({ force: true });
        if (!ok) throw new Error("终端服务重启失败，请稍后重试。");
      }}
      onBack={() => setSettingsOpen(false)} onLaunch={launchCli} />}
    <section className={`workspace ${settingsOpen ? "settings-hidden" : ""}`} aria-hidden={settingsOpen}>
      {sidebarCollapsed && <button className="sidebar-toggle sidebar-toggle-collapsed" onClick={toggleSidebar} title={t("展开工作栏")} aria-label={t("展开工作栏")}><SidebarToggleIcon collapsed /></button>}
      {active && !active.alive && <button className="terminal-restart" onClick={() => restartTerminal(active.id)} title={t("终端已停止，点击重启")}>{t("重启终端")}</button>}
      {updateState?.type === "downloaded" && <div className="update-banner">{t("新版本 {version} 已准备好。", { version: updateState.version || t("已下载") })}<button onClick={() => void window.termbeacon.installUpdate()}>{t("重启并安装")}</button></div>}
      {updateState?.type === "downloading" && <div className="update-progress">{t("正在下载更新 {percent}%", { percent: Math.round(updateState.percent || 0) })}</div>}
      <div className="terminal-stage" ref={terminalStage}>{terminals.map((terminal) => <div key={terminal.id} ref={(node) => { if (node) terminalNodes.current.set(terminal.id, node); }} className="terminal-host" />)}</div>
    </section>
  </main>;
}

export default App;




