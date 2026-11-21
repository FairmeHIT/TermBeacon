const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src/renderer/App.tsx"), "utf8");
const main = fs.readFileSync(path.join(root, "src/main/main.ts"), "utf8");
const preload = fs.readFileSync(path.join(root, "src/main/preload.cjs"), "utf8");

test("update install cannot bypass active-task confirmation", () => {
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = false/);
  assert.match(main, /activeTerminalCount\(stateCache\)/);
  assert.match(main, /acknowledgedBusy !== true/);
  assert.match(app, /acknowledgedBusy: activeIds\.size > 0/);
  assert.match(app, /terminal\.state === "working" \|\| terminal\.state === "awaiting-input"/);
  assert.match(preload, /installUpdate: \(request\) => ipcRenderer\.invoke\("update:install", request\)/);
});

test("update install backs up OpenCode before quitting the app", () => {
  const handler = main.match(/ipcMain\.handle\("update:install"([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(handler, "update:install handler must exist");
  assert.match(handler, /backupNow\(\{ reason: "update"/);
  assert.match(handler, /sessionJournal\(\)\.flush\(\)/);
  assert.match(handler, /autoUpdater\.quitAndInstall/);
  assert.match(handler, /backup-failed/);
});

test("session ids are journaled as soon as the host reports them", () => {
  assert.match(main, /payload\?\.type === "session:update"/);
  assert.match(main, /sessionJournal\(\)\.record\(/);
  assert.match(main, /restoreSessionHints\(stateCache\)/);
  assert.match(main, /readRecentOpenCodeSessions/);
  assert.match(main, /assignRecoverableSessions/);
});

test("settings exposes backup usage and cleanup", () => {
  const settings = fs.readFileSync(path.join(root, "src/renderer/SettingsPage.tsx"), "utf8");
  assert.match(settings, /getOpenCodeBackupInfo/);
  assert.match(settings, /clearOpenCodeBackups/);
  assert.match(settings, /openOpenCodeBackupFolder/);
  assert.match(settings, /OpenCode 会话备份/);
  assert.match(settings, /清理备份/);
  assert.match(main, /opencode:backup-info/);
  assert.match(main, /opencode:backups-clear/);
});
