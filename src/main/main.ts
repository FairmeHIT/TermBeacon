import { app, BrowserWindow, MessageChannelMain, dialog, ipcMain, utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, readFile, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import type { TerminalInstance, Workspace } from "../shared/types";

const require = createRequire(import.meta.url);
const { discoverAll } = require("./cli-discovery.cjs") as {
  discoverAll: () => Record<string, unknown>;
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let ptyHost: Electron.UtilityProcess | null = null;
let rendererReady = false;
let isQuitting = false;
let hostRestartTimer: NodeJS.Timeout | undefined;
const terminals = new Map<string, TerminalInstance>();

interface PersistedState {
  schemaVersion: 1;
  workspaces: Workspace[];
  terminals: TerminalInstance[];
  activeTerminalId?: string;
  activeWorkspaceId?: string;
}

function statePath() { return path.join(app.getPath("userData"), "state.json"); }

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

function notifyHostExit(code?: number, signal?: string, message?: string) {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("pty:host-exit", {
    type: "pty:host-exit",
    code,
    signal,
    message: message || "PTY host exited",
    at: Date.now(),
  });
}

function schedulePtyHostRestart() {
  if (isQuitting || hostRestartTimer) return;
  hostRestartTimer = setTimeout(() => {
    hostRestartTimer = undefined;
    startPtyHost();
    if (rendererReady) connectDataPlane();
  }, 250);
}

function startPtyHost() {
  if (ptyHost || isQuitting) return;
  const hostPath = path.join(__dirname, "pty-host.cjs");
  try {
    const host = utilityProcess.fork(hostPath, [], { serviceName: "TermBeacon PTY Host" });
    ptyHost = host;
    host.on("exit", (code: number) => {
      if (ptyHost !== host) return;
      ptyHost = null;
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
    connectDataPlane();
  });
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  startPtyHost();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  isQuitting = true;
  if (hostRestartTimer) clearTimeout(hostRestartTimer);
  ptyHost?.postMessage({ type: "shutdown" });
  ptyHost?.kill();
});

ipcMain.handle("state:load", async () => readState());
ipcMain.handle("cli:discover", () => discoverAll());
ipcMain.handle("cwd:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
ipcMain.handle("state:save", async (_event, state: PersistedState) => { await writeState(state); return true; });
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

