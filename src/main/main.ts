import { app, BrowserWindow, MessageChannelMain, dialog, ipcMain, Menu, screen, utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, copyFile, mkdir, readFile, stat, unlink, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ShellType, TerminalInstance, WindowBounds, Workspace } from "../shared/types";

const require = createRequire(import.meta.url);
// electron-updater is CommonJS; a named ESM import fails at runtime with
// "Named export 'autoUpdater' not found". Load it through createRequire.
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
const { discoverAll } = require("./cli-discovery.cjs") as {
  discoverAll: () => Record<string, unknown>;
};
const { platformInfo } = require("./platform.cjs") as {
  platformInfo: () => { platform: string; isWindows: boolean; isMac: boolean; shell: string; cwd: string };
};
const { normalizeCreateRequest, protocolError } = require("./pty-validation.cjs") as {
  normalizeCreateRequest: (message: unknown) => {
    terminalId: string; title: string; cwd: string; shell: string; cols: number; rows: number; agentType: string;
  };
  protocolError: (code: string, message: string, details?: Record<string, unknown>) => Error & { code: string };
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ptyHost: Electron.UtilityProcess | null = null;
let rendererReady = false;
let isQuitting = false;
let hostRestartTimer: NodeJS.Timeout | undefined;
let hostRestartAttempts = 0;
let hostStartedAt = 0;
const terminals = new Map<string, TerminalInstance>();
let stateCache: PersistedState | null = null;
let windowSaveTimer: NodeJS.Timeout | undefined;
let updateConfigured = false;
let quitPersisting = false;
const historyWrites = new Map<string, Promise<boolean>>();

interface PersistedState {
  schemaVersion: 1;
  workspaces: Workspace[];
  terminals: TerminalInstance[];
  activeTerminalId?: string;
  activeWorkspaceId?: string;
  defaultShell?: ShellType;
  sidebarWidth?: number;
  windowBounds?: WindowBounds;
}

function statePath() { return path.join(app.getPath("userData"), "state.json"); }
function historyDir() { return path.join(app.getPath("userData"), "terminal-history"); }
function historyPath(terminalId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(terminalId)) return null;
  return path.join(historyDir(), `${terminalId}.log`);
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

async function writeState(state: PersistedState) {
  const target = statePath();
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await rename(temp, target);
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
    void writeState(stateCache);
  }, 400);
}

function sendUpdateEvent(type: string, payload: Record<string, unknown> = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("update:event", { type, ...payload });
}

function configureAutoUpdater() {
  if (updateConfigured || !app.isPackaged || process.env.TERMBEACON_DISABLE_UPDATES === "1") return;
  updateConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => sendUpdateEvent("checking"));
  autoUpdater.on("update-available", (info) => sendUpdateEvent("available", { version: info.version }));
  autoUpdater.on("update-not-available", () => sendUpdateEvent("not-available"));
  autoUpdater.on("download-progress", (progress) => sendUpdateEvent("downloading", { percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => sendUpdateEvent("downloaded", { version: info.version }));
  autoUpdater.on("error", (error) => sendUpdateEvent("error", { message: error instanceof Error ? error.message : String(error) }));
  void autoUpdater.checkForUpdates().catch(() => undefined);
}

async function loadTerminalHistory(terminalId: string) {
  const target = historyPath(terminalId);
  if (!target) return "";
  try {
    const raw = await readFile(target, "utf8");
    return raw.length > 250_000 ? raw.slice(-250_000) : raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function appendTerminalHistory(terminalId: string, data: string) {
  if (typeof data !== "string" || data.length === 0) return true;
  const target = historyPath(terminalId);
  if (!target) return true;
  const previous = historyWrites.get(terminalId) || Promise.resolve(true);
  const next = previous.catch(() => true).then(async () => {
    await mkdir(historyDir(), { recursive: true });
    await appendFile(target, data, "utf8");
    try {
      const details = await stat(target);
      if (details.size > 400_000) {
        const raw = await readFile(target, "utf8");
        await writeFile(target, raw.slice(-250_000), "utf8");
      }
    } catch { /* history is a convenience; a failed trim must not affect PTY */ }
    return true;
  });
  historyWrites.set(terminalId, next);
  void next.then(() => {
    if (historyWrites.get(terminalId) === next) historyWrites.delete(terminalId);
  }, () => {
    if (historyWrites.get(terminalId) === next) historyWrites.delete(terminalId);
  });
  return next;
}

async function removeTerminalHistory(terminalId: string) {
  const target = historyPath(terminalId);
  if (!target) return true;
  await (historyWrites.get(terminalId) || Promise.resolve(true)).catch(() => true);
  try { await unlink(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

function notifyHostEvent(
  type: "pty:host-exit" | "pty:host-stopped",
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
  if (isQuitting || hostRestartTimer) return;
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
    if (rendererReady) connectDataPlane();
  }, plan.delayMs);
}

function startPtyHost() {
  if (ptyHost || isQuitting) return;
  const hostPath = path.join(__dirname, "pty-host.cjs");
  try {
    const host = utilityProcess.fork(hostPath, [], { serviceName: "TermBeacon PTY Host" });
    ptyHost = host;
    hostStartedAt = Date.now();
    // Surface host crashes in the dev console; without this a host exception
    // is completely silent and only manifests as dead terminals in the UI.
    host.stdout?.on("data", (chunk: Buffer) => console.log(`[pty-host:${host.pid}]`, chunk.toString().trimEnd()));
    host.stderr?.on("data", (chunk: Buffer) => console.error(`[pty-host:${host.pid}]`, chunk.toString().trimEnd()));
    host.on("exit", (code: number) => {
      if (ptyHost !== host) return;
      ptyHost = null;
      console.error(`[pty-host] exited with code ${code}`);
      if (isQuitting) return;
      notifyHostExit(code);
      schedulePtyHostRestart();
    });
  } catch (error) {
    ptyHost = null;
    notifyHostExit(undefined, undefined, error instanceof Error ? error.message : String(error));
    schedulePtyHostRestart();
  }
}

function connectDataPlane() {
  if (!mainWindow || !ptyHost) return;
  const channel = new MessageChannelMain();
  ptyHost.postMessage({ type: "connect" }, [channel.port1]);
  mainWindow.webContents.postMessage("pty:connect", null, [channel.port2]);
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
        { role: "quit", label: "退出" },
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
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
    connectDataPlane();
  });
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

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
    registerMenu();
    startPtyHost();
    createWindow(stateCache);
    configureAutoUpdater();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(stateCache || defaultState()); });
  });
}
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (!quitPersisting && stateCache) {
    event.preventDefault();
    quitPersisting = true;
    const bounds = currentWindowBounds();
    if (bounds) stateCache = { ...stateCache, windowBounds: bounds };
    void writeState(stateCache).catch(() => undefined).finally(() => app.quit());
    return;
  }
  isQuitting = true;
  if (hostRestartTimer) clearTimeout(hostRestartTimer);
  if (windowSaveTimer) clearTimeout(windowSaveTimer);
  ptyHost?.postMessage({ type: "shutdown" });
  ptyHost?.kill();
});

ipcMain.handle("state:load", async () => {
  if (!stateCache) stateCache = await readState();
  return stateCache;
});
ipcMain.handle("cli:discover", () => discoverAll());
ipcMain.handle("platform:info", () => platformInfo());
ipcMain.handle("cwd:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
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
ipcMain.handle("update:install", () => {
  if (!updateConfigured) return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
});
ipcMain.handle("pty:restart-host", () => {
  if (isQuitting) return false;
  if (hostRestartTimer) {
    clearTimeout(hostRestartTimer);
    hostRestartTimer = undefined;
  }
  hostRestartAttempts = 0;
  if (ptyHost) {
    if (rendererReady) connectDataPlane();
    return true;
  }
  startPtyHost();
  if (rendererReady) connectDataPlane();
  return true;
});
ipcMain.handle("pty:create", (_event, request) => {
  let normalized;
  try {
    normalized = normalizeCreateRequest(request);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as { code?: string }).code : "INVALID_REQUEST";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pty:create rejected: ${code}: ${message}`);
  }
  const terminal: TerminalInstance = {
    id: normalized.terminalId, title: normalized.title, cwd: normalized.cwd, agentType: normalized.agentType as TerminalInstance["agentType"],
    state: "ready", alive: true, lastActivityAt: Date.now(),
  };
  terminals.set(terminal.id, terminal);
  return { terminalId: terminal.id };
});

