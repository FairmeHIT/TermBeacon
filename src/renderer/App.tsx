import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentState, AgentType, PersistedState, PlatformInfo, PtyAgentEvent, PtyCwdEvent, PtyErrorEvent, PtyExitEvent, PtyHostExitEvent, PtyOutputEvent, PtyTitleEvent, ShellType, StateUpdateEvent, TaskRecord, TaskState, TerminalInstance, Workspace } from "../shared/types";
import taskHistoryUtils from "../main/task-history.cjs";
import "./styles.css";

const { cleanTaskPrompt, applyTaskEvent, settleTask: settleTaskRecords } = taskHistoryUtils as {
  cleanTaskPrompt: (value: string) => string | undefined;
  applyTaskEvent: (items: TaskRecord[], event: StateUpdateEvent, prompt?: string) => TaskRecord[];
  settleTask: (items: TaskRecord[], terminalId: string, state: Extract<TaskState, "completed" | "error" | "cancelled">, at: number, detail?: string) => TaskRecord[];
};

// Mirrors the payload the main process sends on update:event and returns from
// update:check / update:state.
type UpdateStatus = { type: string; version?: string; percent?: number; message?: string };

declare global {
  interface CliInfo {
    id: AgentType;
    command: string;
    installed: boolean;
    executable?: string;
    version?: string;
  }

  interface Window {
    termbeacon: {
      loadState(): Promise<PersistedState>;
      saveState(state: PersistedState): Promise<boolean>;
      discoverCli(): Promise<Record<string, CliInfo>>;
      getPlatformInfo(): Promise<PlatformInfo>;
      pickCwd(): Promise<string | null>;
      loadHistory(terminalId: string): Promise<string>;
      appendHistory(terminalId: string, data: string): Promise<boolean>;
      removeHistory(terminalId: string): Promise<boolean>;
      installUpdate(): Promise<boolean>;
      getUpdateState(): Promise<{ status: UpdateStatus; currentVersion: string; packaged: boolean; configured: boolean }>;
      checkForUpdates(): Promise<UpdateStatus>;
      restartHost(): Promise<boolean>;
      createTerminal(request: unknown): Promise<unknown>;
      write(request: unknown): void;
      launch(request: unknown): void;
      resize(request: unknown): void;
      replay(request: unknown): void;
      kill(request: unknown): void;
      viewed(terminalId: string): void;
      rebuildDetector(request: unknown): void;
      onOutput(listener: (event: PtyOutputEvent) => void): () => void;
      onState(listener: (event: StateUpdateEvent) => void): () => void;
      onExit(listener: (event: PtyExitEvent) => void): () => void;
      onError(listener: (event: PtyErrorEvent) => void): () => void;
      onHost(listener: (event: PtyHostExitEvent) => void): () => void;
      onTitle(listener: (event: PtyTitleEvent) => void): () => void;
      onCwd(listener: (event: PtyCwdEvent) => void): () => void;
      onAgent(listener: (event: PtyAgentEvent) => void): () => void;
      onUpdate(listener: (event: UpdateStatus) => void): () => void;
    };
  }
}

// One line of feedback for the settings popover, derived from the last update
// event so it stays in sync with the banner above the terminal.
function describeUpdate(status: UpdateStatus | null, packaged: boolean) {
  if (!packaged) return "开发模式（未打包），不检查更新";
  if (!status) return "";
  switch (status.type) {
    case "checking": return "正在检查更新…";
    case "available": return `发现新版本 ${status.version ?? ""}，正在后台下载…`;
    case "downloading": return `正在下载更新 ${Math.round(status.percent || 0)}%`;
    case "not-available": return "已是最新版本";
    case "downloaded": return `新版本 ${status.version ?? ""} 已下载，重启应用即可安装`;
    case "disabled": return "已禁用更新检查（TERMBEACON_DISABLE_UPDATES=1）";
    case "unsupported": return status.message ?? "当前版本不支持自动更新";
    case "error": return `检查失败：${status.message ?? "未知错误"}`;
    default: return "";
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

const taskStateLabel: Record<TaskState, string> = {
  working: "工作中",
  completed: "已完成",
  "awaiting-input": "等待输入",
  error: "异常",
  cancelled: "已中断",
};

const taskStateClass: Record<TaskState, string> = {
  working: "working",
  completed: "completed",
  "awaiting-input": "awaiting",
  error: "error",
  cancelled: "stopped",
};

const agentLabel: Record<AgentType, string> = {
  generic: "",
  opencode: "opencode",
  codex: "Codex",
  claude: "Claude Code",
};

const shellLabel: Record<string, string> = {
  "cmd.exe": "命令提示符",
  "powershell.exe": "PowerShell",
  "pwsh.exe": "PowerShell 7",
  "/bin/bash": "Bash",
  "/bin/zsh": "Zsh",
};

function terminalCliLabel(terminal: TerminalInstance): string {
  return agentLabel[terminal.agentType] || shellLabel[terminal.shell || DEFAULT_SHELL] || terminal.shell || "Shell";
}

function isGeneratedTerminalTitle(title: string): boolean {
  return /^终端\s+\d+$/.test(title.trim());
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

function formatTaskTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "dark"
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.7A8.8 8.8 0 0 1 8.3 3.6a8.8 8.8 0 1 0 12.1 12.1Z" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></svg>;
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
function EditableTitle({ title, onCommit }: { title: string; onCommit: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);
  if (!editing) return <strong title="双击重命名" onDoubleClick={() => { setDraft(title); setEditing(true); }}>{title}</strong>;
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
  const [taskHistoryOpen, setTaskHistoryOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo>(FALLBACK_PLATFORM);
  const [defaultShell, setDefaultShell] = useState<ShellType>(DEFAULT_SHELL);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("termbeacon-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem("termbeacon-sidebar-collapsed") === "true");
  const [hostDown, setHostDown] = useState(false);
  const [hostMessage, setHostMessage] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [updateState, setUpdateState] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [appPackaged, setAppPackaged] = useState(true);
  const [updateBusy, setUpdateBusy] = useState(false);
  const terminalNodes = useRef(new Map<string, HTMLDivElement>());
  const terminalViews = useRef(new Map<string, Terminal>());
  const fitAddons = useRef(new Map<string, FitAddon>());
  const consumedLocal = useRef(new Map<string, number>());
  const terminalStage = useRef<HTMLDivElement | null>(null);
  const pendingOutput = useRef(new Map<string, { at: number; summary?: string }>());
  const pendingHistory = useRef(new Map<string, string[]>());
  const historyFlushTimer = useRef<number | null>(null);
  const lastSavedState = useRef("");
  const outputFlushTimer = useRef<number | null>(null);
  const lastInput = useRef(new Map<string, string>());
  const inputBuffers = useRef(new Map<string, string>());
  // Terminal titles the user renamed by hand. OSC 0/2 title reports from the
  // shell/agent must not overwrite a name the user chose on purpose.
  const pinnedTitles = useRef(new Set<string>());

  const active = useMemo(() => terminals.find((terminal) => terminal.id === activeId) ?? terminals[0], [activeId, terminals]);
  const activeWorkspace = useMemo(() => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0], [workspaces, activeWorkspaceId]);
  const workspaceTerminals = useMemo(() => terminals.filter((terminal) => activeWorkspace?.terminalIds.includes(terminal.id)), [terminals, activeWorkspace]);
  const activeTasks = useMemo(() => tasks
    .filter((task) => task.terminalId === activeId)
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, 20), [tasks, activeId]);

  function flushPendingHistory() {
    const pending = new Map(pendingHistory.current);
    pendingHistory.current.clear();
    pending.forEach((chunks, terminalId) => {
      if (chunks.length > 0) void window.termbeacon.appendHistory(terminalId, chunks.join(""));
    });
  }

  useEffect(() => {
    void Promise.all([window.termbeacon.getPlatformInfo(), window.termbeacon.loadState()]).then(([info, state]) => {
      setPlatformInfo(info);
      const runtimeDefaultShell = isSupportedShell(info.shell) ? info.shell : DEFAULT_SHELL;
      const restoredDefaultShell = isSupportedShell(state.defaultShell) ? state.defaultShell : runtimeDefaultShell;
      setDefaultShell(restoredDefaultShell);
      setTasks(state.tasks ?? []);
      if (typeof state.sidebarWidth === "number") setSidebarWidth(state.sidebarWidth);
      const freshTerminal = state.terminals.length === 0 ? newTerminal(1, restoredDefaultShell, info.cwd) : null;
      if (state.terminals.length > 0) {
        const restoredTerminals = state.terminals.map((terminal) => ({
          ...terminal,
          // A restored PTY starts a fresh shell. Agent detection upgrades this
          // to Codex, Claude Code, or opencode when its banner appears.
          agentType: "generic" as AgentType,
          shell: isSupportedShell(terminal.shell) ? terminal.shell : restoredDefaultShell,
          titlePinned: terminal.titlePinned ?? !isGeneratedTerminalTitle(terminal.title),
          alive: false,
          state: "stopped" as AgentState,
        }));
        pinnedTitles.current = new Set(restoredTerminals.filter((terminal) => terminal.titlePinned).map((terminal) => terminal.id));
        setTerminals(restoredTerminals);
      } else {
        setTerminals(freshTerminal ? [freshTerminal] : []);
      }
      const restored = state.workspaces.length > 0
        ? state.workspaces
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
      } else {
        setWorkspaces(restored);
        const workspaceTerminalIds = restored.find((workspace) => workspace.id === restoredActiveWorkspaceId)?.terminalIds ?? [];
        const fallbackId = workspaceTerminalIds.find((id) => state.terminals.some((terminal) => terminal.id === id));
        setActiveId(state.activeTerminalId ?? fallbackId ?? state.terminals[0].id);
      }
      setActiveWorkspaceId(restoredActiveWorkspaceId);
      setHydrated(true);
    });
    const disposeOutput = window.termbeacon.onOutput((event) => {
      const view = terminalViews.current.get(event.terminalId);
      if (view && event.replay && consumedLocal.current.has(event.terminalId) && (consumedLocal.current.get(event.terminalId) ?? 0) >= event.sequence) return;
      if (view && Number.isInteger(event.sequence)) {
        const seen = consumedLocal.current.get(event.terminalId) ?? 0;
        if (event.sequence <= seen && !event.replay) return;
        consumedLocal.current.set(event.terminalId, Math.max(seen, event.sequence));
      }
      view?.write(event.data);
      if (!event.replay) {
        const chunks = pendingHistory.current.get(event.terminalId) || [];
        chunks.push(event.data);
        pendingHistory.current.set(event.terminalId, chunks);
        if (historyFlushTimer.current === null) {
          historyFlushTimer.current = window.setTimeout(() => {
            historyFlushTimer.current = null;
            flushPendingHistory();
          }, 750);
        }
      }
      // Sidebar summaries are cosmetic; coalesce them so a fast PTY stream does
      // not re-render the whole app on every chunk. xterm writes stay immediate.
      pendingOutput.current.set(event.terminalId, { at: event.at, summary: event.summary });
      if (outputFlushTimer.current === null) {
        outputFlushTimer.current = window.setTimeout(() => {
          outputFlushTimer.current = null;
          const pending = new Map(pendingOutput.current);
          pendingOutput.current.clear();
          if (pending.size === 0) return;
          setTerminals((items) => items.map((item) => {
            const update = pending.get(item.id);
            return update ? { ...item, lastActivityAt: update.at, lastOutputSummary: update.summary ?? item.lastOutputSummary } : item;
          }));
        }, 100);
      }
    });
    const disposeState = window.termbeacon.onState((event) => {
      setTerminals((items) => items.map((item) => item.id === event.terminalId ? { ...item, state: event.current, lastOutputSummary: event.summary ?? item.lastOutputSummary, alive: event.current !== "stopped" } : item));
      setTasks((items) => applyTaskEvent(items, event, lastInput.current.get(event.terminalId)));
    });
    const disposeExit = window.termbeacon.onExit((event) => {
      setTerminals((items) => items.map((item) => item.id === event.terminalId ? { ...item, alive: false, state: event.reason === "user-kill" || event.exitCode === 0 ? "stopped" : "error" } : item));
      setTasks((items) => settleTaskRecords(items, event.terminalId, event.reason === "user-kill" || event.exitCode === 0 ? "cancelled" : "error", event.at, event.reason));
    });
    const disposeError = window.termbeacon.onError((event) => {
      if (!event.terminalId) return;
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, alive: false, state: "error", lastOutputSummary: String(event.message || "PTY request failed").slice(-90) }
        : item));
      setTasks((items) => settleTaskRecords(items, event.terminalId, "error", event.at, event.message));
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
        ? { ...task, state: "error", finishedAt: event.at, error: event.message || "PTY host 已断开", summary: event.message || "PTY host 已断开" }
        : task));
      setTerminals((items) => items.map((item) => item.alive
        ? { ...item, alive: false, state: "error", lastOutputSummary: event.message || "PTY host 已断开" }
        : item));
    });
    const disposeTitle = window.termbeacon.onTitle((event) => {
      if (pinnedTitles.current.has(event.terminalId)) return;
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
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, agentType: event.agentType }
        : item));
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
      disposeOutput(); disposeState(); disposeExit(); disposeError(); disposeHost(); disposeTitle(); disposeCwd(); disposeAgent(); disposeUpdate();
      document.removeEventListener("visibilitychange", flushOnVisibilityChange);
      window.removeEventListener("beforeunload", flushPendingHistory);
      flushPendingHistory();
      if (outputFlushTimer.current !== null) {
        window.clearTimeout(outputFlushTimer.current);
        outputFlushTimer.current = null;
      }
      if (historyFlushTimer.current !== null) {
        window.clearTimeout(historyFlushTimer.current);
        historyFlushTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("termbeacon-theme", theme);
    terminalViews.current.forEach((term) => { term.options.theme = terminalThemes[theme]; });
  }, [theme]);

  useEffect(() => {
    if (!hydrated) return;
    terminals.forEach((terminal) => {
      if (terminalViews.current.has(terminal.id)) return;
      const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: "Cascadia Mono, Consolas, monospace",
        fontSize: 14,
        scrollback: 20000,
        theme: terminalThemes[theme],
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.onData((data) => {
        const buffer = inputBuffers.current.get(terminal.id) || "";
        const submitted = data.includes("\r") || data.includes("\n");
        if (submitted) {
          const prompt = cleanTaskPrompt(`${buffer}${data.replace(/[\r\n].*$/, "")}`);
          if (prompt) lastInput.current.set(terminal.id, prompt);
          inputBuffers.current.delete(terminal.id);
        } else {
          if (/^\x1b/.test(data)) {
            window.termbeacon.write({ terminalId: terminal.id, data });
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
        }
        window.termbeacon.write({ terminalId: terminal.id, data });
      });
      terminalViews.current.set(terminal.id, term);
      fitAddons.current.set(terminal.id, fit);
      const node = terminalNodes.current.get(terminal.id);
      if (node) term.open(node);
      void (async () => {
        try {
          const history = await window.termbeacon.loadHistory(terminal.id);
          if (history && terminalViews.current.get(terminal.id) === term) term.write(history);
          await window.termbeacon.createTerminal({
            terminalId: terminal.id,
            title: terminal.title,
            cwd: terminal.cwd,
            shell: terminal.shell || defaultShell,
            args: [],
            cols: 120,
            rows: 32,
            agentType: terminal.agentType,
          });
          setTerminals((items) => items.map((item) => item.id === terminal.id ? { ...item, alive: true, state: "ready" } : item));
          requestAnimationFrame(() => fitTerminal(terminal.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setTerminals((items) => items.map((item) => item.id === terminal.id
            ? { ...item, alive: false, state: "error", lastOutputSummary: message.slice(-90) }
            : item));
        }
      })();
    });
  }, [terminals, hydrated, platformInfo.shell]);

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
        state: "stopped" as AgentState,
        alive: false,
        lastActivityAt: 0,
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
      void window.termbeacon.saveState(state);
    }, 150);
    return () => window.clearTimeout(handle);
  }, [terminals, workspaces, activeId, activeWorkspaceId, tasks, defaultShell, sidebarWidth, hydrated]);

  useEffect(() => {
    terminalViews.current.forEach((term, id) => {
      const node = terminalNodes.current.get(id);
      if (node) node.style.display = id === activeId ? "block" : "none";
    });
    requestAnimationFrame(() => fitTerminal(activeId));
  }, [activeId]);

  useEffect(() => {
    if (!hydrated) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        fitTerminal(activeId);
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
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        addTerminal();
        return;
      }
      if (key === "w") {
        event.preventDefault();
        if (activeId) removeTerminal(activeId);
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
  }, [activeId, workspaceTerminals, terminals, workspaces, activeWorkspaceId]);

  function fitTerminal(id: string) {
    const fit = fitAddons.current.get(id);
    if (!fit) return;
    try {
      fit.fit();
      const term = terminalViews.current.get(id);
      if (term) window.termbeacon.resize({ terminalId: id, cols: term.cols, rows: term.rows });
    } catch { /* container may not be visible yet */ }
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

  // Manual check from the settings popover. The main process keeps a single
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

  const updateHint = describeUpdate(updateState, appPackaged);

  function restartTerminal(id: string) {
    const terminal = terminals.find((item) => item.id === id);
    if (!terminal || terminal.alive) return;
    const term = terminalViews.current.get(id);
    try { term?.reset(); } catch { /* view may already be gone */ }
    void window.termbeacon.createTerminal({
      terminalId: terminal.id,
      title: terminal.title,
      cwd: terminal.cwd,
      shell: terminal.shell || defaultShell,
      args: [],
      cols: term?.cols ?? 120,
      rows: term?.rows ?? 32,
      agentType: terminal.agentType,
    }).then(() => {
      setTerminals((items) => items.map((item) => item.id === id ? { ...item, alive: true, state: "ready" } : item));
      requestAnimationFrame(() => fitTerminal(id));
    }).catch((error: Error) => {
      setTerminals((items) => items.map((item) => item.id === id
        ? { ...item, alive: false, state: "error", lastOutputSummary: error.message.slice(-90) }
        : item));
    });
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
    setActiveId(id);
    window.termbeacon.viewed(id);
    setTerminals((items) => items.map((item) => item.id === id && item.state === "completed-unseen" ? { ...item, state: "ready" } : item));
    focusTerminalView(id);
  }

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    window.localStorage.setItem("termbeacon-sidebar-collapsed", String(next));
    if (next) setSettingsOpen(false);
  }

  function addTerminal() {
    const terminal = newTerminal(terminals.length + 1, defaultShell);
    setTerminals((items) => [...items, terminal]);
    setWorkspaces((items) => items.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, terminalIds: [...workspace.terminalIds, terminal.id] } : workspace));
    setActiveId(terminal.id);
  }

  function removeTerminal(id: string) {
    const target = terminals.find((item) => item.id === id);
    if (!target) return;
    if (!window.confirm(`删除终端「${target.title}」？正在运行的进程会被停止。`)) return;
    if (target.alive) window.termbeacon.kill({ terminalId: id, reason: "user-kill" });
    const view = terminalViews.current.get(id);
    if (view) {
      try { view.dispose(); } catch { /* view may already be disposed */ }
    }
    terminalViews.current.delete(id);
    fitAddons.current.delete(id);
    consumedLocal.current.delete(id);
    terminalNodes.current.delete(id);
    pendingHistory.current.delete(id);
    lastInput.current.delete(id);
    inputBuffers.current.delete(id);
    setTasks((items) => items.filter((task) => task.terminalId !== id));
    void window.termbeacon.removeHistory(id);
    const owner = workspaces.find((workspace) => workspace.terminalIds.includes(id));
    const remaining = owner ? owner.terminalIds.filter((terminalId) => terminalId !== id) : [];
    if (id === activeId && remaining.length === 0) {
      const replacement = newTerminal(terminals.length, defaultShell);
      setTerminals((items) => [...items.filter((item) => item.id !== id), replacement]);
      setWorkspaces((items) => items.map((workspace) => workspace.id === owner?.id ? { ...workspace, terminalIds: [replacement.id] } : workspace));
      setActiveId(replacement.id);
      return;
    }
    if (id === activeId) setActiveId(remaining[0]);
    pinnedTitles.current.delete(id);
    setTerminals((items) => items.filter((item) => item.id !== id));
    setWorkspaces((items) => items.map((workspace) => workspace.id === owner?.id ? { ...workspace, terminalIds: remaining } : workspace));
  }

  function selectWorkspace(id: string) {
    setActiveWorkspaceId(id);
    const nextTerminalId = workspaces.find((workspace) => workspace.id === id)?.terminalIds[0];
    if (nextTerminalId && terminals.some((terminal) => terminal.id === nextTerminalId)) {
      setActiveId(nextTerminalId);
      focusTerminalView(nextTerminalId);
    }
  }

  function addWorkspace() {
    const terminal = newTerminal(terminals.length + 1, defaultShell);
    const workspace: Workspace = { id: crypto.randomUUID(), name: `工作区 ${workspaces.length + 1}`, terminalIds: [terminal.id] };
    setTerminals((items) => [...items, terminal]);
    setWorkspaces((items) => [...items, workspace]);
    setActiveWorkspaceId(workspace.id);
    setActiveId(terminal.id);
  }

  function renameWorkspace(id: string, name: string) {
    setWorkspaces((items) => items.map((workspace) => workspace.id === id ? { ...workspace, name } : workspace));
  }

  function removeWorkspace(id: string) {
    if (workspaces.length < 2) return;
    const target = workspaces.find((workspace) => workspace.id === id);
    if (!target) return;
    if (!window.confirm(`删除工作区「${target.name}」及其中的 ${target.terminalIds.length} 个终端？`)) return;
    target.terminalIds.forEach((terminalId) => {
      const terminal = terminals.find((item) => item.id === terminalId);
      if (terminal?.alive) window.termbeacon.kill({ terminalId, reason: "user-kill" });
    });
    const removedIds = new Set(target.terminalIds);
    removedIds.forEach((id) => pinnedTitles.current.delete(id));
    removedIds.forEach((terminalId) => {
      try { terminalViews.current.get(terminalId)?.dispose(); } catch { /* view may already be disposed */ }
      terminalViews.current.delete(terminalId);
      fitAddons.current.delete(terminalId);
      consumedLocal.current.delete(terminalId);
      terminalNodes.current.delete(terminalId);
      pendingHistory.current.delete(terminalId);
      lastInput.current.delete(terminalId);
      inputBuffers.current.delete(terminalId);
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
    setTerminals((items) => items.map((item) => item.id === id ? { ...item, title, titlePinned: true } : item));
  }

  async function pickCwd() {
    if (!active) return;
    const picked = await window.termbeacon.pickCwd();
    if (!isValidCwd(picked)) return;
    setTerminals((items) => items.map((item) => item.id === active.id ? { ...item, cwd: picked } : item));
  }

  return <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <aside className="sidebar">
      {!sidebarCollapsed && <>
      <div className="brand-row"><div><div className="brand">TermBeacon</div><div className="subtitle">CLI Agent 工作台</div></div><div className="brand-actions"><button className="sidebar-toggle" onClick={toggleSidebar} title="隐藏工作栏" aria-label="隐藏工作栏"><SidebarToggleIcon collapsed={false} /></button><button className="add-button" onClick={addTerminal} title="新建终端" aria-label="新建终端"><PlusIcon /></button></div></div>
      <div className="workspace-chips">
        {workspaces.map((workspace) => <button key={workspace.id} className={`workspace-chip ${workspace.id === activeWorkspaceId ? "active" : ""}`} onClick={() => selectWorkspace(workspace.id)} title={workspace.name}>
          <EditableTitle title={workspace.name} onCommit={(next) => renameWorkspace(workspace.id, next)} />
          {workspaces.length > 1 && <span className="workspace-remove" onClick={(event) => { event.stopPropagation(); removeWorkspace(workspace.id); }} title={`删除工作区「${workspace.name}」`} role="button" aria-label={`删除工作区「${workspace.name}」`}>×</span>}
        </button>)}
        <button className="workspace-chip add-chip" onClick={addWorkspace} title="新建工作区" aria-label="新建工作区"><PlusIcon /><span>新建工作区</span></button>
      </div>
      <div className="terminal-list">
        {workspaceTerminals.map((terminal) => <button key={terminal.id} className={`terminal-item ${terminal.id === activeId ? "active" : ""}`} onClick={() => selectTerminal(terminal.id)}>
          <span className={`status-dot ${stateClass[terminal.state]}`} />
          <span className="terminal-copy"><EditableTitle title={terminal.title} onCommit={(next) => renameTerminal(terminal.id, next)} /><small>{terminalCliLabel(terminal)} · {stateLabel[terminal.state]}</small></span>
          {terminal.id === activeId && <span className="active-mark">●</span>}
          <span className="terminal-remove" onClick={(event) => { event.stopPropagation(); removeTerminal(terminal.id); }} title="删除终端">×</span>
        </button>)}
      </div>
      {hostDown && <div className="host-alert">
        <span>{hostMessage || "PTY Host 已断开"}</span>
        <button onClick={restartHost}>重启 PTY Host</button>
      </div>}
      <div className="sidebar-footer">
        <button className={`sidebar-tool ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((open) => !open)} title="打开设置" aria-label="打开设置"><SettingsIcon /></button>
        <button className="sidebar-tool theme-tool" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}><ThemeIcon theme={theme} /></button>
      </div>
      <div className="sidebar-resizer" onPointerDown={beginSidebarResize} title="拖动调整侧栏宽度" />
      </>}
    </aside>
    {settingsOpen && <div className="settings-popover">
      <div className="settings-title">设置</div>
      <div className="settings-caption">主题</div>
      <div className="theme-options" role="group" aria-label="主题">
        {(["dark", "light"] as Theme[]).map((option) => <button key={option} className={`theme-option ${theme === option ? "selected" : ""}`} onClick={() => setTheme(option)}><ThemeIcon theme={option} />{option === "dark" ? "深色" : "浅色"}</button>)}
      </div>
      <div className="settings-caption">默认 Shell</div>
      <select className="shell-select" value={defaultShell} onChange={(event) => setDefaultShell(event.target.value as ShellType)} aria-label="默认 Shell">
        {SHELL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <div className="settings-caption">更新</div>
      <div className="settings-update">
        <span>{appVersion ? `当前版本 ${appVersion}` : "当前版本未知"}</span>
        <button onClick={() => void checkForUpdates()} disabled={updateBusy || updateState?.type === "downloading"}>{updateBusy ? "检查中…" : "检查更新"}</button>
      </div>
      {updateHint && <div className={`settings-hint ${updateState?.type === "error" ? "error" : ""}`}>{updateHint}</div>}
      {updateState?.type === "downloaded" && <button className="settings-install" onClick={() => void window.termbeacon.installUpdate()}>重启并安装 {updateState.version || "新版本"}</button>}
    </div>}
    <section className="workspace">
      {sidebarCollapsed && <button className="sidebar-toggle sidebar-toggle-collapsed" onClick={toggleSidebar} title="展开工作栏" aria-label="展开工作栏"><SidebarToggleIcon collapsed /></button>}
      <header className="workspace-header">
        <div><span className="cwd-picker" onClick={pickCwd} title="点击选择工作目录（下次启动生效）">{active?.cwd}</span></div>
        {active && <div className="header-actions"><button className={taskHistoryOpen ? "active" : ""} onClick={() => setTaskHistoryOpen((open) => !open)}>任务历史</button>{!active.alive && <button onClick={() => restartTerminal(active.id)}>重启终端</button>}</div>}
      </header>
      {updateState?.type === "downloaded" && <div className="update-banner">新版本 {updateState.version || "已下载"} 已准备好。<button onClick={() => void window.termbeacon.installUpdate()}>重启并安装</button></div>}
      {updateState?.type === "downloading" && <div className="update-progress">正在下载更新 {Math.round(updateState.percent || 0)}%</div>}
      {taskHistoryOpen && <aside className="task-history-panel">
        <div className="task-history-heading"><strong>最近任务</strong><span>{activeTasks.length}</span></div>
        {activeTasks.length === 0 && <div className="task-history-empty">当前终端还没有任务记录</div>}
        {activeTasks.map((task) => <div className="task-history-item" key={task.id}>
          <span className={`status-dot ${taskStateClass[task.state]}`} />
          <div><strong>{task.prompt || task.summary || "未命名任务"}</strong><small>{taskStateLabel[task.state]} · {formatTaskTime(task.startedAt)}{task.finishedAt ? ` · ${Math.max(0, Math.round((task.finishedAt - task.startedAt) / 1000))}s` : ""}</small>{task.error && <em>{task.error}</em>}</div>
        </div>)}
      </aside>}
      <div className="terminal-stage" ref={terminalStage}>{terminals.map((terminal) => <div key={terminal.id} ref={(node) => { if (node) terminalNodes.current.set(terminal.id, node); }} className="terminal-host" />)}</div>
    </section>
  </main>;
}

export default App;




