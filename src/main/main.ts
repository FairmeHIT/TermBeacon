import { app, BrowserWindow, MessageChannelMain, dialog, ipcMain, Menu, screen } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, copyFile, mkdir, readFile, stat, unlink, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ShellType, TaskRecord, TerminalInstance, WindowBounds, Workspace } from "../shared/types";

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
const { getResumeSpec } = require("./session-resume.cjs") as {
  getResumeSpec: (request: { agentType?: string; sessionId?: string; cwd?: string; shell?: string }) => Record<string, unknown>;
};
const {
  resolveAssets,
  installOpencodePlugin,
  configureClaude,
  integrationStatus,
} = require("./integration-config.cjs") as {
  resolveAssets: (options: { packaged: boolean; resourcesPath: string; appPath: string; executablePath: string }) => { opencodePlugin: string; hookScript: string; hookCommand?: string | null };
  installOpencodePlugin: (options: { assets: { opencodePlugin: string; hookScript: string } }) => { target: string; existed: boolean; bytes: number };
  configureClaude: (options: { assets: { opencodePlugin: string; hookScript: string } }) => { target: string; backupPath?: string; hookScript: string };
  integrationStatus: (options: { assets: { opencodePlugin: string; hookScript: string } }) => Record<string, unknown>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ptyHostProcess: ChildProcess | null = null;
let hostSocket: Socket | null = null;
let rendererPort: Electron.MessagePortMain | null = null;
let hostSocketName: string | null = null;
let hostConnectTimer: NodeJS.Timeout | undefined;
const hostMessageQueue: unknown[] = [];
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
// Last update result, kept so the settings popover can show it without
// waiting for a new event (the renderer may open after the startup check).
type UpdateStatus = { type: string; version?: string; percent?: number; message?: string };
let updateStatus: UpdateStatus = { type: "idle" };
let updateCheckInFlight = false;
const historyWrites = new Map<string, Promise<boolean>>();
let stateWriteTail: Promise<void> = Promise.resolve();
let stateWriteSequence = 0;
const MAX_HOST_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_HOOK_INPUT_BYTES = 128 * 1024;

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
function historyPath(terminalId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(terminalId)) return null;
  return path.join(historyDir(), `${terminalId}.log`);
}

function integrationAssets() {
  return resolveAssets({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), executablePath: process.execPath });
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
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => sendUpdateEvent("checking"));
  autoUpdater.on("update-available", (info) => sendUpdateEvent("available", { version: info.version }));
  autoUpdater.on("update-not-available", () => sendUpdateEvent("not-available"));
  autoUpdater.on("download-progress", (progress) => sendUpdateEvent("downloading", { percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => sendUpdateEvent("downloaded", { version: info.version }));
  autoUpdater.on("error", (error) => sendUpdateEvent("error", { message: error instanceof Error ? error.message : String(error) }));
}

// Both the startup check and the settings button go through here, so a second
// click cannot start a concurrent check and the renderer always gets the last
// known result back (electron-updater rejects overlapping checks).
async function checkForUpdatesNow() {
  if (!app.isPackaged) return { ...updateStatus, type: "unsupported", message: "开发模式（未打包）不检查更新" } as UpdateStatus;
  if (process.env.TERMBEACON_DISABLE_UPDATES === "1") return { ...updateStatus, type: "disabled", message: "已通过 TERMBEACON_DISABLE_UPDATES 禁用更新" } as UpdateStatus;
  configureAutoUpdater();
  if (updateStatus.type === "downloaded" || updateCheckInFlight) return updateStatus;
  updateCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    sendUpdateEvent("error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    updateCheckInFlight = false;
  }
  return updateStatus;
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
  if (!hostSocket || hostSocket.destroyed || !hostSocket.writable) {
    queueHostMessage(message);
    return;
  }
  try {
    hostSocket.write(`${JSON.stringify(message)}\n`);
  } catch {
    queueHostMessage(message);
  }
}

function flushHostMessages() {
  if (!hostSocket || hostSocket.destroyed || !hostSocket.writable) return;
  const pending = hostMessageQueue.splice(0);
  for (const message of pending) sendHostMessage(message);
}

function attachHostSocket(socket: Socket) {
  if (hostSocket && hostSocket !== socket) {
    try { hostSocket.destroy(); } catch { /* stale connection */ }
  }
  hostSocket = socket;
  hostStartedAt = hostStartedAt || Date.now();
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
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
    if (isQuitting) return;
    notifyHostEvent("pty:host-disconnected", undefined, undefined, "PTY Host 连接已断开");
    schedulePtyHostRestart();
  });
  flushHostMessages();
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

async function runHookMode() {
  const port = process.env.TERMBEACON_HOOK_PORT;
  const token = process.env.TERMBEACON_HOOK_TOKEN;
  const terminalId = process.env.TERMBEACON_TERMINAL_ID;
  let raw = "";
  let inputTooLarge = false;
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      const text = String(chunk);
      if (Buffer.byteLength(raw, "utf8") + Buffer.byteLength(text, "utf8") > MAX_HOOK_INPUT_BYTES) {
        inputTooLarge = true;
        continue;
      }
      raw += text;
    }
  }
  let input: Record<string, unknown> = {};
  try { input = !inputTooLarge && raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { input = {}; }
  const args = process.argv.slice(2);
  const positional = args.filter((value) => !value.startsWith("--"));
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const event = String(option("event") || positional[1] || input.hook_event_name || input.event || "hook");
  const statusByEvent: Record<string, string> = {
    SessionStart: "started", UserPromptSubmit: "running", PreToolUse: "running", PostToolUse: "running",
    PreCompact: "running", Notification: "waiting", Stop: "completed", SubagentStop: "completed", SessionEnd: "completed",
  };
  const status = String(option("status") || positional[0] || statusByEvent[event] || "running");
  const validStatuses = new Set(["started", "running", "waiting", "completed", "failed"]);
  if (!validStatuses.has(status)) {
    console.error(`[termbeacon-hook] unknown status: ${status}`);
    process.exitCode = 1;
  } else if (port && token && terminalId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-termbeacon-token": token },
        body: JSON.stringify({ terminalId, event, status }),
        signal: controller.signal,
      });
      if (!response.ok) console.error(`[termbeacon-hook] bridge returned HTTP ${response.status}`);
    } catch {
      console.error("[termbeacon-hook] could not reach the TermBeacon hook bridge");
    } finally {
      clearTimeout(timer);
    }
  }
  app.quit();
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
ipcMain.handle("cli:discover", () => discoverAll());
ipcMain.handle("platform:info", () => platformInfo());
ipcMain.handle("session:resume-spec", (_event, request) => getResumeSpec(request || {}));
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
ipcMain.handle("integration:status", () => integrationStatus({ assets: integrationAssets() }));
ipcMain.handle("integration:install-opencode", () => installOpencodePlugin({ assets: integrationAssets() }));
ipcMain.handle("integration:configure-claude", () => configureClaude({ assets: integrationAssets() }));
ipcMain.handle("pty:restart-host", () => {
  if (isQuitting) return false;
  if (hostRestartTimer) {
    clearTimeout(hostRestartTimer);
    hostRestartTimer = undefined;
  }
  hostRestartAttempts = 0;
  if (hostSocket) {
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
}

