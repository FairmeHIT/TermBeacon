import { app, BrowserWindow, MessageChannelMain, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from "electron";
import type { MessageBoxOptions } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, stat, unlink, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ShellType, TaskRecord, TerminalInstance, WindowBounds, Workspace } from "../shared/types";
import type { AgentCliId, CliProgress, CliScan, CliPlan, CloseToTraySettings, CloseToTrayPreference } from "../shared/types";
import type { OpenCodeModelCatalog, OpenCodeModelsConfig, OpenCodeModelDiscovery, OpenCodeModelDiscoveryRequest, OpenCodeModelsMutation, OpenCodeProviderDraft } from "../shared/types";

// Running from source must not collide with the installed build. The packaged
// app already owns the default profile and its single-instance lock, so a dev
// launch would otherwise quit immediately (exit 0) and take Vite down with it.
// Give the dev UI its own profile: both builds can run side by side, and dev
// experiments never touch the installed app's state or terminal history.
if (!app.isPackaged) {
  app.setName("TermBeacon Dev");
  app.setPath("userData", path.join(app.getPath("appData"), "termbeacon-dev"));
}

const require = createRequire(import.meta.url);
// electron-updater is CommonJS; a named ESM import fails at runtime with
// "Named export 'autoUpdater' not found". Load it through createRequire.
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
const { FreshGitHubProvider, checkForUpdatesWithRetry, formatUpdateError } = require("./update-check.cjs") as {
  FreshGitHubProvider: new (...args: unknown[]) => unknown;
  checkForUpdatesWithRetry: <T>(check: () => Promise<T>, options?: { onRetry?: (attempt: number, total: number) => void }) => Promise<T>;
  formatUpdateError: (error: unknown) => string;
};
const { createCliManager, CATALOG: cliCatalog } = require("./cli-manager.cjs") as {
  CATALOG: Record<string, { docs: string }>;
  createCliManager: (options: { assets: unknown; onProgress: (event: CliProgress) => void }) => {
    scan(): Promise<CliScan>;
    plan(request: unknown): Promise<CliPlan>;
    execute(request: unknown): Promise<unknown>;
    launch(request: { id: AgentCliId; shell?: string; args?: string[] }): Promise<{ command: string; executable: string }>;
    models(request?: { id?: AgentCliId; cwd?: string }): Promise<{ models: string[]; executable: string }>;
  };
};
const { createHistoryStore } = require("./terminal-history.cjs") as {
  createHistoryStore: (options: { directory: string }) => {
    load: (id: string) => Promise<string>;
    append: (id: string, data: string) => Promise<boolean>;
    remove: (id: string) => Promise<boolean>;
  };
};
const { platformInfo } = require("./platform.cjs") as {
  platformInfo: () => { platform: string; isWindows: boolean; isMac: boolean; shell: string; cwd: string };
};
const { sanitizeState, defaultState } = require("./state-sanitize.cjs") as {
  sanitizeState: (parsed: unknown) => PersistedState;
  defaultState: () => PersistedState;
};
const { fitWindowToWorkArea, centeredWindowBounds } = require("./window-bounds.cjs") as {
  fitWindowToWorkArea: (
    bounds: { width: number; height: number; x: number; y: number },
    workArea: { width: number; height: number; x: number; y: number },
  ) => { x: number; y: number; width: number; height: number };
  centeredWindowBounds: (
    size: { width: number; height: number },
    workArea: { width: number; height: number; x: number; y: number },
  ) => { x: number; y: number; width: number; height: number };
};
const { planRestart } = require("./host-restart.cjs") as {
  planRestart: (state: { attempts: number; uptimeMs: number }) => {
    attempts: number; delayMs: number; giveUp: boolean;
  };
};
const { getResumeSpec, sessionIdFitsAgent } = require("./session-resume.cjs") as {
  getResumeSpec: (request: { agentType?: string; sessionId?: string; sessionAgent?: string; cwd?: string; shell?: string }) => { supported: boolean; args?: string[]; [key: string]: unknown };
  sessionIdFitsAgent: (agentType: string, value: unknown) => boolean;
};
const { createSessionJournal } = require("./session-journal.cjs") as {
  createSessionJournal: (options: { file: string }) => {
    load: () => Promise<Record<string, { sessionId: string; agentType: AgentCliId; at: number }>>;
    record: (entry: { terminalId?: string; sessionId?: string; agentType?: string; at?: number }) => Promise<boolean>;
    forget: (terminalId: string) => Promise<boolean>;
    flush: () => Promise<void>;
  };
};
const { resolveOpenCodeDataDir } = require("./opencode-paths.cjs") as {
  resolveOpenCodeDataDir: () => string;
};
const { assignRecoverableSessions, readRecentOpenCodeSessions, resolveDuplicateSessionOwners } = require("./opencode-sessions.cjs") as {
  assignRecoverableSessions: (
    terminals: TerminalInstance[],
    sessions: Array<{ id: string; directory: string; timeCreated: number; timeUpdated: number; title?: string; source: string }>,
    options?: { now?: number; platform?: string },
  ) => Array<{ terminalId: string; sessionId: string; agentType: "opencode"; at: number }>;
  readRecentOpenCodeSessions: (options: { dataDir: string }) => {
    sessions: Array<{ id: string; directory: string; timeCreated: number; timeUpdated: number; title?: string; source: string }>;
    source: string;
    error: string | null;
  };
  resolveDuplicateSessionOwners: (
    terminals: TerminalInstance[],
    sessions: Array<{ id: string; directory: string }>,
    options?: { platform?: string },
  ) => { cleared: Array<{ terminalId: string; sessionId: string; ownerTerminalId: string }>; unresolved: string[] };
};
const { createOpenCodeBackup } = require("./opencode-backup.cjs") as {
  createOpenCodeBackup: (options: { dataDir: string; backupDir: string }) => {
    backupNow: (options?: { reason?: string; minIntervalMs?: number; onlyIfChanged?: boolean }) => Promise<{
      ok: boolean; skipped?: boolean; reason?: string; file?: string; bytes?: number; rawBytes?: number; error?: string;
    }>;
    info: () => Promise<{ directory: string; count: number; bytes: number; latestAt?: number; latestFile?: string; retention: number }>;
    clear: () => Promise<{ directory: string; count: number; bytes: number; latestAt?: number; latestFile?: string; retention: number }>;
  };
};
const { createOpenCodeModelsStore } = require("./opencode-models.cjs") as {
  createOpenCodeModelsStore: (options?: { listModels?: () => Promise<string[]> }) => {
    snapshot: () => OpenCodeModelsConfig;
    saveProvider: (draft: OpenCodeProviderDraft) => Promise<OpenCodeModelsMutation>;
    deleteProvider: (id: string) => Promise<OpenCodeModelsMutation>;
    setDefaultModel: (model: string | null) => Promise<OpenCodeModelsMutation>;
    catalog: () => Promise<OpenCodeModelCatalog>;
    discover: (request: OpenCodeModelDiscoveryRequest) => Promise<OpenCodeModelDiscovery>;
    configPath: () => string;
  };
};
const { resolveAssets } = require("./integration-config.cjs") as {
  resolveAssets: (options: { packaged: boolean; resourcesPath: string; appPath: string; executablePath: string }) => { opencodePlugin: string; hookScript: string; hookCommand?: string | null; codexHookCommand?: string | null };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ptyHostProcess: ChildProcess | null = null;
let hostSocket: Socket | null = null;
let hostSocketBlocked = false;
let rendererPort: Electron.MessagePortMain | null = null;
let hostSocketName: string | null = null;
let hostConnectTimer: NodeJS.Timeout | undefined;
const hostMessageQueue: unknown[] = [];
let rendererReady = false;
let isQuitting = false;
let hostRestartTimer: NodeJS.Timeout | undefined;
let hostRestartAttempts = 0;
let hostStartedAt = 0;
let stateCache: PersistedState | null = null;
let windowSaveTimer: NodeJS.Timeout | undefined;
let updateConfigured = false;
let quitPersisting = false;
// Close-to-tray state. The tray keeps the app alive after the window is
// "closed"; preference lives in state.json (`ask` shows the choice dialog
// once and remembers the answer; `exit` restores the classic quit behavior).
let tray: Tray | null = null;
let trayBalloonShown = false;
let closeToTrayPreference: CloseToTrayPreference = "ask";
// Last update result, kept so the settings page can show it without
// waiting for a new event (the renderer may open after the startup check).
type UpdateStatus = { type: string; version?: string; percent?: number; message?: string };
let updateStatus: UpdateStatus = { type: "idle" };
let updateCheckInFlight = false;
let terminalHistory: ReturnType<typeof createHistoryStore> | undefined;
let stateWriteTail: Promise<void> = Promise.resolve();
let stateWriteSequence = 0;
const MAX_HOST_MESSAGE_BYTES = 4 * 1024 * 1024;

// Electron's nativeTheme only picks a light or dark frame. Windows 11 also
// exposes the DWM caption colors, so palettes such as warm paper can tint the
// standard title bar instead of leaving a white strip above the app. Windows 10
// returns an error for these attributes; the light/dark frame remains intact.
type CaptionColors = { caption?: unknown; text?: unknown; border?: unknown };
let captionProcess: ChildProcess | null = null;
let lastCaptionKey = "";

function colorRef(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  const color = Number.parseInt(value.slice(1), 16);
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  return (blue << 16) | (green << 8) | red;
}

function applyWindowsCaption(window: BrowserWindow, colors: CaptionColors) {
  if (process.platform !== "win32") return;
  const caption = colorRef(colors.caption);
  const text = colorRef(colors.text);
  const border = colorRef(colors.border);
  if (caption === undefined || text === undefined) return;
  let hwnd: bigint;
  try {
    const handle = window.getNativeWindowHandle();
    hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  } catch {
    return;
  }
  const key = `${hwnd}:${caption}:${text}:${border ?? "none"}`;
  if (key === lastCaptionKey) return;
  lastCaptionKey = key;
  // EncodedCommand avoids every quoting layer between Node, PowerShell and the
  // inline C# here-string. Values are numeric and validated before interpolation.
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TermBeaconDwm {
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
$h = [IntPtr]::new([long]${hwnd.toString()})
$c = ${caption}
$t = ${text}
$b = ${border ?? -1}
[void][TermBeaconDwm]::DwmSetWindowAttribute($h, 35, [ref]$c, 4)
[void][TermBeaconDwm]::DwmSetWindowAttribute($h, 36, [ref]$t, 4)
if ($b -ge 0) { [void][TermBeaconDwm]::DwmSetWindowAttribute($h, 34, [ref]$b, 4) }
# The frame is not always invalidated by the attribute change alone.
[void][TermBeaconDwm]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0037)
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try { captionProcess?.kill(); } catch { /* already exited */ }
  const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    windowsHide: true,
    timeout: 5000,
  }, (error) => {
    if (captionProcess === child) captionProcess = null;
    // Let a later theme switch retry after a transient PowerShell failure.
    if (error) lastCaptionKey = "";
  });
  captionProcess = child;
}

interface PersistedState {
  schemaVersion: 1;
  workspaces: Workspace[];
  terminals: TerminalInstance[];
  tasks?: TaskRecord[];
  activeTerminalId?: string;
  activeWorkspaceId?: string;
  defaultShell?: ShellType;
  autoResumeOnStart?: boolean;
  opencodeThemeSync?: boolean;
  sidebarWidth?: number;
  workspaceSectionHeight?: number;
  workspaceSectionRatio?: number;
  windowBounds?: WindowBounds;
  closeToTray?: CloseToTraySettings;
}

function statePath() { return path.join(app.getPath("userData"), "state.json"); }
function historyDir() { return path.join(app.getPath("userData"), "terminal-history"); }
function historyStore() { return terminalHistory ??= createHistoryStore({ directory: historyDir() }); }
function sessionJournalFile() { return path.join(app.getPath("userData"), "session-journal.json"); }
function openCodeBackupDir() { return path.join(app.getPath("userData"), "opencode-backups"); }
let sessionJournalStore: ReturnType<typeof createSessionJournal> | undefined;
function sessionJournal() { return sessionJournalStore ??= createSessionJournal({ file: sessionJournalFile() }); }
let openCodeBackupStore: ReturnType<typeof createOpenCodeBackup> | undefined;
function openCodeBackup() {
  return openCodeBackupStore ??= createOpenCodeBackup({
    dataDir: resolveOpenCodeDataDir(),
    backupDir: openCodeBackupDir(),
  });
}
let openCodeModelsStore: ReturnType<typeof createOpenCodeModelsStore> | undefined;
function openCodeModels() {
  return openCodeModelsStore ??= createOpenCodeModelsStore({
    listModels: async () => (await agentManager().models({ id: "opencode", cwd: app.getPath("home") })).models,
  });
}

function integrationAssets() {
  return resolveAssets({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), executablePath: process.execPath });
}

let cliManager: ReturnType<typeof createCliManager> | undefined;
function agentManager() {
  return cliManager ??= createCliManager({ assets: integrationAssets(), onProgress: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("cli:progress", event);
  } });
}

async function readState(): Promise<PersistedState> {
  const target = statePath();
  try {
    const raw = await readFile(target, "utf8");
    return sanitizeState(JSON.parse(raw) as unknown);
  } catch (error) {
    // Preserve the unusable file for inspection instead of silently losing it
    // to the next save; a missing file (ENOENT) is the normal first launch.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try { await copyFile(target, `${target}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    }
    return defaultState();
  }
}

// state.json is written with a short debounce. The session journal and the
// OpenCode database close that gap: a terminal that lost its saved id can still
// reopen the conversation it actually owned instead of falling back to "最近会话".
async function restoreSessionHints(state: PersistedState) {
  try {
    const entries = await sessionJournal().load();
    let recovered = 0;
    for (const terminal of state.terminals) {
      const entry = entries[terminal.id];
      if (!entry || entry.agentType !== terminal.agentType) continue;
      if (!sessionIdFitsAgent(terminal.agentType, entry.sessionId)) continue;
      if (terminal.lastSessionId === entry.sessionId && terminal.lastSessionAgent === entry.agentType) continue;
      terminal.lastSessionId = entry.sessionId;
      terminal.lastSessionAgent = entry.agentType;
      terminal.resumeAvailable = true;
      recovered += 1;
    }
    if (recovered > 0) console.log(`[session-journal] restored ${recovered} terminal session id(s)`);
  } catch (error) {
    console.warn("[session-journal] load failed", error);
  }

  const unresolved = state.terminals.filter((terminal) => terminal.agentType === "opencode"
    && !(terminal.lastSessionAgent === "opencode" && sessionIdFitsAgent("opencode", terminal.lastSessionId)));
  // A stale duplicate does not need the fallback assignment, but it does need
  // the session store to decide which claimant owns the conversation.
  const duplicateIds = resolveDuplicateSessionOwners(state.terminals, []).unresolved;
  if (unresolved.length === 0 && duplicateIds.length === 0) return;
  try {
    const result = readRecentOpenCodeSessions({ dataDir: resolveOpenCodeDataDir() });
    if (result.error) console.warn("[opencode-sessions] read failed", result.error);
    const resolution = resolveDuplicateSessionOwners(state.terminals, result.sessions, { platform: process.platform });
    for (const conflict of resolution.cleared) {
      const terminal = state.terminals.find((item) => item.id === conflict.terminalId);
      if (!terminal) continue;
      // Keep the id on the terminal whose folder matches the conversation.
      // Clearing it here also removes the terminal from the auto-resume
      // candidates, so a restart cannot open one session in two workspaces.
      terminal.lastSessionId = undefined;
      terminal.lastSessionAgent = undefined;
      terminal.resumeError = "会话属于另一个工作区的终端，已跳过自动恢复";
      await sessionJournal().forget(conflict.terminalId);
    }
    if (resolution.cleared.length > 0) {
      console.log(`[opencode-sessions] dropped ${resolution.cleared.length} duplicate session owner(s)`);
    }
    if (resolution.unresolved.length > 0) {
      console.warn(`[opencode-sessions] ${resolution.unresolved.length} ambiguous duplicate session id(s) stay out of automatic resume`);
    }
    const assignments = assignRecoverableSessions(state.terminals, result.sessions, { platform: process.platform });
    for (const assignment of assignments) {
      const terminal = state.terminals.find((item) => item.id === assignment.terminalId);
      if (!terminal || terminal.agentType !== "opencode") continue;
      terminal.lastSessionId = assignment.sessionId;
      terminal.lastSessionAgent = "opencode";
      terminal.resumeAvailable = true;
      terminal.resumeError = undefined;
    }
    if (assignments.length > 0) console.log(`[opencode-sessions] recovered ${assignments.length} terminal session id(s)`);
  } catch (error) {
    console.warn("[opencode-sessions] recovery scan failed", error);
  }
}

async function writeState(state: PersistedState) {
  const target = statePath();
  const temp = `${target}.tmp-${process.pid}-${++stateWriteSequence}`;
  const serialized = JSON.stringify(state, null, 2);
  const operation = stateWriteTail.catch(() => undefined).then(async () => {
    try {
      await writeFile(temp, serialized, "utf8");
      await rename(temp, target);
    } catch (error) {
      try { await unlink(temp); } catch { /* best effort */ }
      throw error;
    }
  });
  stateWriteTail = operation.catch(() => undefined);
  return operation;
}

function currentWindowBounds(): WindowBounds | undefined {
  if (!mainWindow || mainWindow.isDestroyed()) return undefined;
  const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  return { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, isMaximized: mainWindow.isMaximized() };
}

function scheduleWindowStateSave() {
  if (windowSaveTimer) clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => {
    windowSaveTimer = undefined;
    const bounds = currentWindowBounds();
    if (!bounds || !stateCache) return;
    stateCache = { ...stateCache, windowBounds: bounds };
    void writeState(stateCache).catch((error) => console.error("[state] save failed", error));
  }, 400);
}

function persistCloseToTraySettings() {
  if (!stateCache) return;
  stateCache = { ...stateCache, closeToTray: { preference: closeToTrayPreference, balloonShown: trayBalloonShown } };
  void writeState(stateCache).catch((error) => console.error("[state] close-to-tray save failed", error));
}

function trayIcon(): Electron.NativeImage {
  // Prefer the packaged icon set; fall back to the executable's embedded icon
  // so development runs still show something recognizable.
  const candidates = app.isPackaged
    ? [
      path.join(process.resourcesPath, "icons", "icon-16.png"),
      path.join(process.resourcesPath, "icons", "icon-32.png"),
      path.join(__dirname, "../../icons/icon-16.png"),
    ]
    : [path.join(app.getAppPath(), "build/icons/icon-16.png")];
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(stateCache || defaultState());
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray || process.platform !== "win32") return;
  const icon = trayIcon();
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip("TermBeacon");
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "关闭时驻留托盘",
      type: "checkbox",
      checked: closeToTrayPreference === "minimize-to-tray",
      click: (item) => {
        closeToTrayPreference = item.checked ? "minimize-to-tray" : "exit";
        persistCloseToTraySettings();
      },
    },
    { type: "separator" },
    { label: "退出 TermBeacon", click: () => { void quitApplication(); } },
  ]);
  tray.setContextMenu(menu);
}

async function quitApplication() {
  // Marks a user-initiated exit so the window close handler stops intercepting.
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
}

async function handleWindowClose(event: Electron.Event): Promise<void> {
  if (isQuitting || process.platform !== "win32") return;
  if (closeToTrayPreference === "exit") return;
  if (closeToTrayPreference === "ask") {
    // One-time choice. "No" restores the classic quit-on-close behavior for
    // every later close; "Yes" hides to the tray instead. On Windows the
    // dialog must be synchronous or the window disappears behind it.
    event.preventDefault();
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow!, {
      type: "question",
      buttons: ["驻留托盘", "退出程序"],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "记住我的选择，不再询问",
      checkboxChecked: false,
      noLink: true,
      title: "TermBeacon",
      message: "关闭窗口后要将 TermBeacon 驻留到任务栏托盘吗？",
      detail: "驻留后终端与任务继续在后台运行，可从托盘图标随时恢复窗口或退出。",
    });
    const remember = checkboxChecked === true;
    if (response === 0) {
      closeToTrayPreference = "minimize-to-tray";
    } else {
      closeToTrayPreference = "exit";
      if (remember) {
        persistCloseToTraySettings();
        return;
      }
      // Not remembered: quit right now, leave `ask` for the next launch.
      isQuitting = true;
      app.quit();
      return;
    }
    if (remember) persistCloseToTraySettings();
  }
  // Hide instead of closing. A first-time hide gets a balloon so the app does
  // not look like it vanished from the taskbar. If the tray could not be
  // created, keep the classic quit path so the app is never unreachable.
  event.preventDefault();
  createTray();
  if (!tray) return;
  mainWindow!.hide();
  if (!trayBalloonShown && tray) {
    trayBalloonShown = true;
    persistCloseToTraySettings();
    tray.displayBalloon({
      iconType: "info",
      title: "TermBeacon 仍在运行",
      content: "窗口已驻留到任务栏托盘，终端与任务仍在后台运行。双击托盘图标可恢复窗口。",
    });
  }
}

function sendUpdateEvent(type: string, payload: Record<string, unknown> = {}) {
  updateStatus = { type, ...payload } as UpdateStatus;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("update:event", { type, ...payload });
}

function configureAutoUpdater() {
  if (updateConfigured || !app.isPackaged || process.env.TERMBEACON_DISABLE_UPDATES === "1") return;
  updateConfigured = true;
  autoUpdater.setFeedURL({ provider: "custom", updateProvider: FreshGitHubProvider, owner: "FairmeHIT", repo: "TermBeacon" });
  autoUpdater.autoDownload = true;
  // Installing on ordinary quit would bypass the active-task guard and the
  // pre-update OpenCode backup. Install only from update:install, which runs
  // both checks first.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => sendUpdateEvent("checking"));
  autoUpdater.on("update-available", (info) => sendUpdateEvent("available", { version: info.version }));
  autoUpdater.on("update-not-available", () => sendUpdateEvent("not-available"));
  autoUpdater.on("download-progress", (progress) => sendUpdateEvent("downloading", { percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => sendUpdateEvent("downloaded", { version: info.version }));
  autoUpdater.on("error", (error) => {
    console.error("[update]", error);
    // checkForUpdates emits before rejecting. Let the retry loop decide when
    // the check has failed; download failures still reach the UI immediately.
    if (!updateCheckInFlight) sendUpdateEvent("error", { message: formatUpdateError(error) });
  });
}

// A daily online snapshot of OpenCode's SQLite database, in addition to the
// mandatory backup before an update. The timer is unref'd so it never keeps the
// app alive, and backupNow dedupes overlapping runs.
function scheduleOpenCodeBackups() {
  const run = () => {
    void openCodeBackup().backupNow({ reason: "daily", minIntervalMs: 24 * 60 * 60 * 1000, onlyIfChanged: true })
      .then((result) => {
        if (!result.ok) console.warn("[opencode-backup] daily backup failed", result.error);
        else if (!result.skipped) console.log(`[opencode-backup] ${result.bytes} bytes -> ${result.file}`);
      })
      .catch((error) => console.warn("[opencode-backup] daily backup crashed", error));
  };
  const first = setTimeout(run, 15_000);
  first.unref?.();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref?.();
}

// Both the startup check and the settings button go through here, so a second
// click cannot start a concurrent check and the renderer always gets the last
// known result back (electron-updater rejects overlapping checks).
async function checkForUpdatesNow() {
  if (!app.isPackaged) return { ...updateStatus, type: "unsupported", message: "开发模式（未打包）不检查更新" } as UpdateStatus;
  if (process.env.TERMBEACON_DISABLE_UPDATES === "1") return { ...updateStatus, type: "disabled", message: "已通过 TERMBEACON_DISABLE_UPDATES 禁用更新" } as UpdateStatus;
  configureAutoUpdater();
  if (updateStatus.type === "downloaded" || updateStatus.type === "downloading" || updateCheckInFlight) return updateStatus;
  updateCheckInFlight = true;
  try {
    const result = await checkForUpdatesWithRetry(() => autoUpdater.checkForUpdates(), {
      onRetry: (attempt, total) => sendUpdateEvent("checking", { message: `连接 GitHub 暂时失败，正在重试（${attempt}/${total}）…` }),
    });
    // The updater reports download errors through its error event, but also
    // rejects this separate promise. Always observe it after a manual check.
    void result?.downloadPromise?.catch(() => undefined);
  } catch (error) {
    sendUpdateEvent("error", { message: formatUpdateError(error) });
  } finally {
    updateCheckInFlight = false;
  }
  return updateStatus;
}

async function loadTerminalHistory(terminalId: string) {
  return historyStore().load(terminalId);
}

async function appendTerminalHistory(terminalId: string, data: string) {
  return historyStore().append(terminalId, data);
}

async function removeTerminalHistory(terminalId: string) {
  return historyStore().remove(terminalId);
}

function notifyHostEvent(
  type: "pty:host-exit" | "pty:host-disconnected" | "pty:host-stopped",
  code?: number,
  signal?: string,
  message?: string,
) {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("pty:host-exit", {
    type,
    code,
    signal,
    message: message || "PTY host exited",
    at: Date.now(),
  });
}

function notifyHostExit(code?: number, signal?: string, message?: string) {
  notifyHostEvent("pty:host-exit", code, signal, message);
}

function schedulePtyHostRestart() {
  if (isQuitting || hostRestartTimer || hostSocket) return;
  const plan = planRestart({
    attempts: hostRestartAttempts,
    uptimeMs: hostStartedAt ? Date.now() - hostStartedAt : 0,
  });
  hostRestartAttempts = plan.attempts;
  if (plan.giveUp) {
    notifyHostEvent("pty:host-stopped", undefined, undefined, "PTY host 连续重启失败，请点击“重启 PTY Host”");
    return;
  }
  hostRestartTimer = setTimeout(() => {
    hostRestartTimer = undefined;
    startPtyHost();
  }, plan.delayMs);
}

function getHostSocketName() {
  if (hostSocketName) return hostSocketName;
  const profile = createHash("sha256").update(app.getPath("userData")).digest("hex").slice(0, 16);
  hostSocketName = process.platform === "win32"
    ? `\\\\.\\pipe\\termbeacon-host-${profile}`
    : path.join(app.getPath("userData"), "termbeacon-host.sock");
  return hostSocketName;
}

function queueHostMessage(message: unknown) {
  hostMessageQueue.push(message);
  if (hostMessageQueue.length > 2000) hostMessageQueue.splice(0, hostMessageQueue.length - 2000);
}

function sendHostMessage(message: unknown) {
  if (!hostSocket || hostSocket.destroyed || !hostSocket.writable || hostSocketBlocked) {
    queueHostMessage(message);
    return;
  }
  try {
    hostSocketBlocked = !hostSocket.write(`${JSON.stringify(message)}\n`);
  } catch {
    queueHostMessage(message);
  }
}

function flushHostMessages() {
  if (!hostSocket || hostSocket.destroyed || !hostSocket.writable || hostSocketBlocked) return;
  const pending = hostMessageQueue.splice(0);
  for (const message of pending) sendHostMessage(message);
}

function attachHostSocket(socket: Socket) {
  if (hostSocket && hostSocket !== socket) {
    try { hostSocket.destroy(); } catch { /* stale connection */ }
  }
  hostSocket = socket;
  hostSocketBlocked = false;
  hostStartedAt = hostStartedAt || Date.now();
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("drain", () => {
    if (hostSocket !== socket) return;
    hostSocketBlocked = false;
    flushHostMessages();
  });
  socket.on("data", (chunk) => {
    if (hostSocket !== socket) return;
    pending += chunk;
    // UTF-8 bytes are at most 3x the UTF-16 code-unit count, so a short buffer
    // cannot be oversized. Skipping the byte scan keeps the framing hot path
    // from measuring every socket chunk twice.
    if (pending.length * 3 > MAX_HOST_MESSAGE_BYTES && Buffer.byteLength(pending, "utf8") > MAX_HOST_MESSAGE_BYTES) {
      console.error("[pty-host] oversized socket message");
      pending = "";
      socket.destroy();
      return;
    }
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line);
        if (payload?.type === "pty:host-ready") {
          hostRestartAttempts = 0;
          hostStartedAt = Date.now();
        }
        // The renderer's full state save is debounced; mirror the session id
        // immediately so a crash between the event and the save cannot lose
        // which OpenCode conversation this terminal owns.
        if (payload?.type === "session:update") {
          void sessionJournal().record({
            terminalId: payload.terminalId,
            sessionId: payload.sessionId,
            agentType: payload.agentType,
            at: payload.at,
          }).catch((error) => console.warn("[session-journal] save failed", error));
        }
        rendererPort?.postMessage(payload);
      } catch (error) {
        console.error("[pty-host] invalid socket message", error);
      }
    }
  });
  socket.on("error", (error) => {
    if (hostSocket === socket) console.error("[pty-host] socket error", error.message);
  });
  socket.on("close", () => {
    if (hostSocket !== socket) return;
    hostSocket = null;
    hostSocketBlocked = false;
    if (isQuitting) return;
    notifyHostEvent("pty:host-disconnected", undefined, undefined, "PTY Host 连接已断开");
    schedulePtyHostRestart();
  });
  flushHostMessages();
  if (rendererReady) connectDataPlane();
}

function connectToPtyHost() {
  if (isQuitting || hostSocket) return;
  const socket = createConnection(getHostSocketName());
  let connected = false;
  socket.once("connect", () => {
    connected = true;
    attachHostSocket(socket);
  });
  socket.once("error", () => {
    if (!connected) {
      try { socket.destroy(); } catch { /* connection failed */ }
      scheduleHostConnect();
    }
  });
}

function scheduleHostConnect(delayMs = 100) {
  if (isQuitting || hostSocket || hostConnectTimer) return;
  hostConnectTimer = setTimeout(() => {
    hostConnectTimer = undefined;
    connectToPtyHost();
  }, delayMs);
}

function spawnPtyHost() {
  if (isQuitting || (ptyHostProcess && ptyHostProcess.exitCode === null)) return;
  const hostPath = path.join(__dirname, "../host-app");
  // In development, Electron accepts a second app path after electron.exe.
  // A packaged executable always boots its bundled main entry, so passing the
  // host directory there just starts another copy of the UI and the single
  // instance lock makes it exit immediately. Use an explicit host mode for
  // packaged launches while keeping the detached dev path unchanged.
  const hostArgs = app.isPackaged
    ? ["--termbeacon-pty-host", "--server", getHostSocketName()]
    : [hostPath, "--server", getHostSocketName()];
  try {
    const child = spawn(process.execPath, hostArgs, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    ptyHostProcess = child;
    hostStartedAt = Date.now();
    child.unref();
    child.on("exit", (code, signal) => {
      if (ptyHostProcess !== child) return;
      ptyHostProcess = null;
      if (isQuitting) return;
      console.error(`[pty-host] detached process exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}`);
      if (!hostSocket) {
        notifyHostExit(code ?? undefined, signal ?? undefined);
        schedulePtyHostRestart();
      }
    });
    child.on("error", (error) => {
      if (ptyHostProcess !== child) return;
      ptyHostProcess = null;
      if (!isQuitting) {
        notifyHostExit(undefined, undefined, error.message);
        schedulePtyHostRestart();
      }
    });
  } catch (error) {
    ptyHostProcess = null;
    notifyHostExit(undefined, undefined, error instanceof Error ? error.message : String(error));
    schedulePtyHostRestart();
  }
}

function startPtyHost() {
  if (isQuitting || hostSocket) return;
  connectToPtyHost();
  setTimeout(() => {
    if (!isQuitting && !hostSocket) {
      spawnPtyHost();
      scheduleHostConnect(150);
    }
  }, 100);
}

function connectDataPlane() {
  if (!mainWindow) return;
  try { rendererPort?.close(); } catch { /* old renderer port */ }
  const channel = new MessageChannelMain();
  rendererPort = channel.port1;
  rendererPort.on("message", (event) => {
    try { sendHostMessage(event.data); } catch (error) { console.error("[pty-host] renderer bridge failed", error); }
  });
  rendererPort.start();
  mainWindow.webContents.postMessage("pty:connect", null, [channel.port2]);
  sendHostMessage({ type: "client:attach" });
}

// Application menu. On Windows/Linux the bar is hidden (autoHideMenuBar) —
// TermBeacon's UI is fully self-contained in the sidebar, and the default
// Electron File/Edit/View template only added visual noise. Press Alt to
// reveal it. macOS requires a menu with the standard app role, so a minimal
// localized one is registered there.
function registerMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "TermBeacon",
      submenu: [
        { role: "about", label: "关于 TermBeacon" },
        { type: "separator" },
        { role: "hide", label: "隐藏 TermBeacon" },
        { role: "hideOthers", label: "隐藏其他" },
        { type: "separator" },
        { label: "退出", click: () => { void quitApplication(); } },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(savedState: PersistedState = stateCache || defaultState()) {
  const savedBounds = savedState.windowBounds;
  // Restore onto the display the window was last on (not always the primary
  // one), then shrink/clamp it into that work area: a first launch on a small
  // screen, a display-scaling change or a removed monitor must never leave the
  // window partly off-screen.
  const display = savedBounds
    ? screen.getDisplayMatching({
      x: savedBounds.x ?? 0,
      y: savedBounds.y ?? 0,
      width: savedBounds.width ?? 1280,
      height: savedBounds.height ?? 820,
    })
    : screen.getPrimaryDisplay();
  const bounds = savedBounds
    ? fitWindowToWorkArea({
      x: savedBounds.x ?? display.workArea.x,
      y: savedBounds.y ?? display.workArea.y,
      width: savedBounds.width ?? 1280,
      height: savedBounds.height ?? 820,
    }, display.workArea)
    : centeredWindowBounds({ width: 1280, height: 820 }, display.workArea);
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(900, bounds.width),
    minHeight: Math.min(560, bounds.height),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  if (savedBounds?.isMaximized) mainWindow.maximize();
  mainWindow.on("resize", scheduleWindowStateSave);
  mainWindow.on("move", scheduleWindowStateSave);
  mainWindow.on("maximize", scheduleWindowStateSave);
  mainWindow.on("unmaximize", scheduleWindowStateSave);
  mainWindow.on("close", (event) => { void handleWindowClose(event); });
  mainWindow.webContents.on("did-start-loading", () => {
    rendererReady = false;
    try { rendererPort?.close(); } catch { /* renderer is reloading */ }
    rendererPort = null;
    sendHostMessage({ type: "client:detach" });
  });
  mainWindow.webContents.on("render-process-gone", () => {
    rendererReady = false;
    sendHostMessage({ type: "client:detach" });
  });
  mainWindow.on("closed", () => {
    rendererReady = false;
    rendererPort = null;
    sendHostMessage({ type: "client:detach" });
  });
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
    connectDataPlane();
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    const target = mainWindow;
    target.webContents.on("did-finish-load", () => { target.webContents.openDevTools({ mode: "detach" }); });
  }
  else void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

async function runHookMode() {
  // Use exactly the same mapping, session metadata and retry budget as the
  // standalone script. The build copies the self-contained client here.
  try {
    const { runHook } = require("./hook-client.cjs") as { runHook: () => Promise<void> };
    await runHook();
  } finally { app.quit(); }
}

function runPtyHostMode() {
  const serverIndex = process.argv.indexOf("--server");
  const socketPath = serverIndex >= 0 ? process.argv[serverIndex + 1] : undefined;
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    console.error("[termbeacon-host] missing --server socket path");
    app.exit(1);
    return;
  }

  // Keep the detached host's Chromium profile separate from the UI process.
  // This mirrors src/host-app/package.json in development and avoids profile
  // lock contention when the two Electron processes run concurrently.
  app.setName("termbeacon-host");
  app.setPath("userData", path.join(app.getPath("appData"), "termbeacon-host"));
  app.whenReady().then(() => {
    const lifetimeWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    void lifetimeWindow.loadURL("about:blank");
    require("./pty-host.cjs");
  }).catch((error) => {
    console.error("[termbeacon-host] startup failed", error);
    app.exit(1);
  });
  process.on("uncaughtException", (error) => {
    console.error("[termbeacon-host] uncaught exception", error);
    app.exit(1);
  });
  app.on("window-all-closed", () => {});
}

if (process.argv.includes("--hook")) {
  void runHookMode();
} else if (process.argv.includes("--termbeacon-pty-host")) {
  runPtyHostMode();
} else {
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    stateCache = await readState();
    await restoreSessionHints(stateCache);
    const traySettings = stateCache.closeToTray;
    if (traySettings) {
      closeToTrayPreference = traySettings.preference;
      trayBalloonShown = traySettings.balloonShown;
    }
    registerMenu();
    startPtyHost();
    createWindow(stateCache);
    createTray();
    scheduleOpenCodeBackups();
    void checkForUpdatesNow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(stateCache || defaultState()); });
  });
}
app.on("window-all-closed", () => {
  // Windows: the tray keeps the app alive after the window hides, so the
  // classic quit-on-last-window only applies when nothing is resident.
  if (process.platform !== "darwin" && !tray) app.quit();
});
app.on("before-quit", (event) => {
  if (!quitPersisting && stateCache) {
    event.preventDefault();
    quitPersisting = true;
    const bounds = currentWindowBounds();
    if (bounds) stateCache = { ...stateCache, windowBounds: bounds };
    // Keep the latest close-to-tray choice with the rest of the state.
    stateCache = { ...stateCache, closeToTray: { preference: closeToTrayPreference, balloonShown: trayBalloonShown } };
    void writeState(stateCache).catch(() => undefined).finally(() => app.quit());
    return;
  }
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (hostRestartTimer) clearTimeout(hostRestartTimer);
  if (hostConnectTimer) clearTimeout(hostConnectTimer);
  if (windowSaveTimer) clearTimeout(windowSaveTimer);
  // The detached host owns the PTYs. Closing the UI only detaches the client;
  // an explicit terminal stop still sends pty:kill through the data plane.
  try { hostSocket?.write(`${JSON.stringify({ type: "detach" })}\n`); } catch { /* host may already be gone */ }
  try { hostSocket?.end(); } catch { /* already closed */ }
  hostSocket = null;
  try { rendererPort?.close(); } catch { /* renderer is closing */ }
  rendererPort = null;
  ptyHostProcess?.unref();
});

ipcMain.handle("state:load", async () => {
  if (!stateCache) stateCache = await readState();
  return stateCache;
});
ipcMain.handle("tray:get-settings", () => ({ preference: closeToTrayPreference, balloonShown: trayBalloonShown }));
ipcMain.handle("tray:set-preference", (_event, preference: unknown) => {
  if (preference !== "ask" && preference !== "minimize-to-tray" && preference !== "exit") return false;
  closeToTrayPreference = preference;
  persistCloseToTraySettings();
  rebuildTrayMenu();
  return true;
});
ipcMain.handle("cli:scan", () => agentManager().scan());
ipcMain.handle("cli:plan", (_event, request) => agentManager().plan(request));
ipcMain.handle("cli:execute", (_event, request) => agentManager().execute(request));
ipcMain.handle("cli:launch-spec", (_event, request) => agentManager().launch({
  id: request?.id,
  shell: request?.shell,
}));
ipcMain.handle("cli:docs", async (_event, id) => {
  if (typeof id !== "string" || !Object.hasOwn(cliCatalog, id)) throw new Error("不支持的 Agent CLI");
  await shell.openExternal(cliCatalog[id].docs);
});
ipcMain.handle("platform:info", () => platformInfo());
// Sync the native window frame (title bar, menus, dialogs) with the theme the
// renderer picked, so a dark UI does not sit under a light system title bar.
ipcMain.handle("theme:set", (event, request) => {
  const theme = typeof request === "string" ? { mode: request } : request;
  nativeTheme.themeSource = theme?.mode === "light" ? "light" : "dark";
  const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (window && !window.isDestroyed()) applyWindowsCaption(window, theme ?? {});
  return nativeTheme.shouldUseDarkColors;
});
ipcMain.handle("clipboard:read-text", () => clipboard.readText());
ipcMain.handle("session:resume-spec", async (_event, request) => {
  const spec = getResumeSpec(request || {});
  if (!spec.supported) return spec;
  // A resume command is a fresh CLI process; it needs the same provider and
  // permission flags as a normal launch, or `codex resume` starts against a
  // different profile than the session was created with.
  const launch = await agentManager().launch({ id: request.agentType, shell: request.shell, args: spec.args || [] });
  return { ...spec, command: launch.command };
});
ipcMain.handle("cwd:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
// Reveal a workspace folder in the OS file manager. Only existing directories
// are accepted: shell.openPath would also launch documents and executables, and
// the renderer only ever needs the project folder.
ipcMain.handle("folder:open", async (_event, target: unknown) => {
  if (typeof target !== "string" || !path.isAbsolute(target) || target.length > 4096) {
    return { ok: false, message: "目录无效" };
  }
  try {
    if (!(await stat(target)).isDirectory()) return { ok: false, message: "目录不存在" };
  } catch {
    return { ok: false, message: "目录不存在" };
  }
  const failure = await shell.openPath(target);
  return failure ? { ok: false, message: failure } : { ok: true };
});
// Single-button native message box. Errors must never be silent, and a question
// dialog with a cancel button would misrepresent them.
ipcMain.handle("dialog:message", async (event, request) => {
  const message = typeof request?.message === "string" ? request.message : "";
  if (!message) return false;
  const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  const options: MessageBoxOptions = {
    type: request?.type === "error" ? "error" : "info",
    buttons: [typeof request?.okLabel === "string" && request.okLabel ? request.okLabel : "确定"],
    noLink: true,
    message,
  };
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
  return true;
});
// window.confirm/alert in Electron never report the window as focused again on
// Windows, so after a confirmation every keystroke is dropped until the user
// switches to another app and back. A native message box owned by the main
// process keeps the renderer's focus intact and behaves the same for the user.
ipcMain.handle("dialog:confirm", async (_event, request) => {
  const message = typeof request?.message === "string" ? request.message : "";
  if (!message) return false;
  const owner = BrowserWindow.fromWebContents(_event.sender) ?? mainWindow;
  const options: MessageBoxOptions = {
    type: "question",
    buttons: [request?.okLabel, request?.cancelLabel].filter((label): label is string => typeof label === "string" && label.length > 0),
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message,
  };
  if (options.buttons!.length < 2) options.buttons = ["确定", "取消"];
  if (typeof request?.detail === "string" && request.detail) options.detail = request.detail;
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return result.response === 0;
});
ipcMain.handle("state:save", async (_event, state: PersistedState) => {
  // The renderer is the only writer, but validating here keeps a corrupt or
  // hand-edited payload from replacing a good state.json.
  const sanitized = sanitizeState(state);
  const bounds = currentWindowBounds();
  stateCache = bounds ? { ...sanitized, windowBounds: bounds } : sanitized;
  await writeState(stateCache);
  return true;
});

ipcMain.handle("history:load", async (_event, terminalId: string) => loadTerminalHistory(terminalId));
ipcMain.handle("history:append", async (_event, terminalId: string, data: string) => appendTerminalHistory(terminalId, data));
ipcMain.handle("history:remove", async (_event, terminalId: string) => removeTerminalHistory(terminalId));
ipcMain.handle("opencode:backup-info", () => openCodeBackup().info());
ipcMain.handle("opencode:backup-now", async () => {
  const result = await openCodeBackup().backupNow({ reason: "manual" });
  const info = await openCodeBackup().info();
  return { ...result, info };
});
ipcMain.handle("opencode:backups-clear", async () => {
  const info = await openCodeBackup().clear();
  return info;
});
ipcMain.handle("opencode:backups-open", async () => {
  const failure = await shell.openPath(openCodeBackupDir());
  return failure ? { ok: false, message: failure } : { ok: true };
});
ipcMain.handle("opencode:models", () => openCodeModels().snapshot());
ipcMain.handle("opencode:models-save-provider", (_event, draft: OpenCodeProviderDraft) => openCodeModels().saveProvider(draft));
ipcMain.handle("opencode:models-delete-provider", (_event, id: string) => openCodeModels().deleteProvider(id));
ipcMain.handle("opencode:models-default", (_event, model: string | null) => openCodeModels().setDefaultModel(model));
ipcMain.handle("opencode:models-catalog", () => openCodeModels().catalog());
ipcMain.handle("opencode:models-discover", (_event, request: OpenCodeModelDiscoveryRequest) => openCodeModels().discover(request));
ipcMain.handle("opencode:models-open", async () => {
  const directory = path.dirname(openCodeModels().configPath());
  await mkdir(directory, { recursive: true });
  const failure = await shell.openPath(directory);
  return failure ? { ok: false, message: failure } : { ok: true };
});
function activeTerminalCount(state: PersistedState | null) {
  if (!state) return 0;
  const ids = new Set<string>();
  for (const terminal of state.terminals ?? []) {
    if (terminal.state === "working" || terminal.state === "awaiting-input") ids.add(terminal.id);
  }
  for (const task of state.tasks ?? []) {
    if (task.state === "working" || task.state === "awaiting-input") ids.add(task.terminalId);
  }
  return ids.size;
}
let updateInstallInFlight = false;
ipcMain.handle("update:install", async (_event, request?: { activeTerminals?: number; acknowledgedBusy?: boolean }) => {
  if (!updateConfigured) return { ok: false, reason: "not-ready", message: "更新尚未配置" };
  if (updateInstallInFlight) return { ok: false, reason: "busy", message: "正在准备更新，请稍候" };
  const reported = Number.isFinite(request?.activeTerminals) ? Math.max(0, Math.floor(request!.activeTerminals!)) : 0;
  const active = Math.max(reported, activeTerminalCount(stateCache));
  if (active > 0 && request?.acknowledgedBusy !== true) {
    return { ok: false, reason: "busy", activeTerminals: active };
  }
  updateInstallInFlight = true;
  try {
    // SQLite's online backup API reads a consistent snapshot including the
    // WAL, so a running OpenCode process cannot leave a torn backup.
    const backup = await openCodeBackup().backupNow({ reason: "update" });
    if (!backup.ok) return { ok: false, reason: "backup-failed", message: backup.error || "OpenCode 会话备份失败" };
    await sessionJournal().flush();
    await writeState(stateCache || defaultState());
    autoUpdater.quitAndInstall(false, true);
    return { ok: true, ...(backup.skipped ? {} : { backup: { file: backup.file, bytes: backup.bytes } }) };
  } catch (error) {
    return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    updateInstallInFlight = false;
  }
});
ipcMain.handle("update:state", () => ({
  status: updateStatus,
  currentVersion: app.getVersion(),
  packaged: app.isPackaged,
  configured: updateConfigured,
}));
ipcMain.handle("update:check", () => checkForUpdatesNow());
ipcMain.handle("pty:restart-host", (_event, request) => {
  if (isQuitting) return false;
  if (hostRestartTimer) {
    clearTimeout(hostRestartTimer);
    hostRestartTimer = undefined;
  }
  hostRestartAttempts = 0;
  if (hostSocket) {
    if (request?.force === true) {
      sendHostMessage({ type: "shutdown" });
      return true;
    }
    if (rendererReady) connectDataPlane();
    return true;
  }
  startPtyHost();
  if (rendererReady) connectDataPlane();
  return true;
});
}

