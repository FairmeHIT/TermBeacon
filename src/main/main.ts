import { app, BrowserWindow, MessageChannelMain, clipboard, dialog, ipcMain, Menu, screen, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, readFile, unlink, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ShellType, TaskRecord, TerminalInstance, WindowBounds, Workspace } from "../shared/types";
import type { AgentCliId, CliProgress, CliScan, CliPlan } from "../shared/types";

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
const { getResumeSpec } = require("./session-resume.cjs") as {
  getResumeSpec: (request: { agentType?: string; sessionId?: string; cwd?: string; shell?: string }) => { supported: boolean; args?: string[]; [key: string]: unknown };
};
const { resolveAssets } = require("./integration-config.cjs") as {
  resolveAssets: (options: { packaged: boolean; resourcesPath: string; appPath: string; executablePath: string }) => { opencodePlugin: string; hookScript: string; hookCommand?: string | null };
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
// Last update result, kept so the settings page can show it without
// waiting for a new event (the renderer may open after the startup check).
type UpdateStatus = { type: string; version?: string; percent?: number; message?: string };
let updateStatus: UpdateStatus = { type: "idle" };
let updateCheckInFlight = false;
let terminalHistory: ReturnType<typeof createHistoryStore> | undefined;
let stateWriteTail: Promise<void> = Promise.resolve();
let stateWriteSequence = 0;
const MAX_HOST_MESSAGE_BYTES = 4 * 1024 * 1024;

interface PersistedState {
  schemaVersion: 1;
  workspaces: Workspace[];
  terminals: TerminalInstance[];
  tasks?: TaskRecord[];
  activeTerminalId?: string;
  activeWorkspaceId?: string;
  defaultShell?: ShellType;
  sidebarWidth?: number;
  windowBounds?: WindowBounds;
}

function statePath() { return path.join(app.getPath("userData"), "state.json"); }
function historyDir() { return path.join(app.getPath("userData"), "terminal-history"); }
function historyStore() { return terminalHistory ??= createHistoryStore({ directory: historyDir() }); }

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
  autoUpdater.autoInstallOnAppQuit = true;
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
    if (Buffer.byteLength(pending, "utf8") > MAX_HOST_MESSAGE_BYTES) {
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
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
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
    registerMenu();
    startPtyHost();
    createWindow(stateCache);
    void checkForUpdatesNow();
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
ipcMain.handle("cli:scan", () => agentManager().scan());
ipcMain.handle("cli:plan", (_event, request) => agentManager().plan(request));
ipcMain.handle("cli:execute", (_event, request) => agentManager().execute(request));
ipcMain.handle("cli:launch-spec", (_event, request) => agentManager().launch({ id: request?.id, shell: request?.shell }));
ipcMain.handle("cli:docs", async (_event, id) => {
  if (typeof id !== "string" || !Object.hasOwn(cliCatalog, id)) throw new Error("不支持的 Agent CLI");
  await shell.openExternal(cliCatalog[id].docs);
});
ipcMain.handle("platform:info", () => platformInfo());
ipcMain.handle("clipboard:read-text", () => clipboard.readText());
ipcMain.handle("session:resume-spec", async (_event, request) => {
  const spec = getResumeSpec(request || {});
  if (!spec.supported) return spec;
  const launch = await agentManager().launch({ id: request.agentType, shell: request.shell, args: spec.args });
  return { ...spec, command: launch.command };
});
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
  return writeState(stateCache || defaultState())
    .catch((error) => {
      console.error("[state] update install save failed", error);
    })
    .then(() => {
      autoUpdater.quitAndInstall(false, true);
      return true;
    });
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

