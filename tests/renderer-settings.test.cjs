const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../src/renderer/App.tsx"), "utf8");
const launch = fs.readFileSync(path.join(__dirname, "../src/main/agent-launch.cjs"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");

test("brand header uses a beacon mark and only the product name", () => {
  const brandRow = app.match(/<div className="brand-row">([\s\S]*?)<\/div>\s*<section className="sidebar-section workspaces-section">/)?.[1];
  assert.ok(brandRow, "brand row must exist");
  assert.match(brandRow, /<BrandMark\s*\/>/);
  assert.match(brandRow, /className="brand">TermBeacon<\/div>/);
  assert.doesNotMatch(brandRow, /CLI Agent|工作台|subtitle/);
  const mark = app.match(/function BrandMark\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(mark, "BrandMark must exist");
  assert.match(mark, /aria-hidden="true"/);
  assert.match(styles, /\.brand-mark\s*\{/);
  assert.match(styles, /\.brand-lockup\s*\{/);
});

test("settings icon uses a conventional gear", () => {
  const icon = app.match(/function SettingsIcon\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(icon, "SettingsIcon must exist");
  assert.equal((icon.match(/<path /g) || []).length, 1);
  assert.equal((icon.match(/<circle /g) || []).length, 1);
  assert.match(icon, /M12\.22 2/);
});

test("sidebar controls expose collapse and a visible new-terminal action", () => {
  assert.match(app, /title=\{t\("隐藏工作栏"\)\}/);
  assert.match(app, /title=\{t\("展开工作栏"\)\}/);
  assert.match(app, /aria-label=\{t\("新建终端"\)\}><PlusIcon\s*\/>/);
  const footer = app.match(/<div className="sidebar-footer">([\s\S]*?)<\/div>/)?.[1];
  assert.match(footer, /className="sidebar-tool sidebar-toggle"/);
  const toggle = styles.match(/\.sidebar-toggle\s*\{([\s\S]*?)\}/)?.[1];
  assert.match(toggle, /color:\s*var\(--muted-strong\)/);
  assert.match(toggle, /background:\s*transparent/);
  assert.match(toggle, /width:\s*28px/);
  const collapsed = styles.match(/\.sidebar-toggle-collapsed\s*\{([\s\S]*?)\}/)?.[1];
  assert.match(collapsed, /bottom:\s*14px/);
  assert.doesNotMatch(collapsed, /top:\s*14px/);
});

test("workspaces and terminals render as distinct labeled sections", () => {
  // Both sections live in the sidebar with their own headers and add actions.
  assert.match(app, /<section className="sidebar-section workspaces-section">/);
  assert.match(app, /<section className="sidebar-section terminals-section">/);
  assert.match(app, /<span className="sidebar-section-title">\{t\("工作区"\)\}<\/span>/);
  assert.match(app, /<span className="sidebar-section-title">\{t\("终端"\)\}<\/span>/);
  // The sections are visually separated, not one blended column.
  const separators = styles.match(/\.terminals-section\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(separators, "terminals section styles must exist");
  assert.match(separators, /border-top:\s*1px solid var\(--border\)/);
  // The workspace list is a vertical, scrollable list of folder cards.
  const list = styles.match(/\.workspace-list\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(list, "workspace list styles must exist");
  assert.match(list, /flex-direction:\s*column/);
  assert.match(list, /overflow-y:\s*auto/);
  const item = styles.match(/\.workspace-item\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(item, "workspace item styles must exist");
  assert.match(item, /grid-template-columns:\s*16px minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(item, /height:\s*26px/, "workspace items are cards, not one-row chips");
  assert.match(app, /aria-label=\{t\("添加工作区（选择本地文件夹）"\)\}><PlusIcon/);
  assert.match(app, /ref=\{workspaceStrip\}/);
});

test("workspace sections keep their own add actions next to the title", () => {
  // Each section header carries its own + button scoped to that section.
  const workspacesHeader = app.match(/<section className="sidebar-section workspaces-section">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(workspacesHeader, "workspaces section must exist");
  assert.match(workspacesHeader, /onClick=\{addWorkspace\}/);
  const terminalsHeader = app.match(/<section className="sidebar-section terminals-section">([\s\S]*?)<div className="terminal-list">/)?.[1];
  assert.ok(terminalsHeader, "terminals section header must exist");
  assert.match(terminalsHeader, /onClick=\{addTerminal\}/);
});

test("workspace removal remains available for the active workspace", () => {
  assert.match(app, /workspaces\.length > 1 && <span className="workspace-remove"/);
  assert.doesNotMatch(app, /workspace\.id !== activeWorkspaceId && <span className="workspace-remove"/);
});

test("workspace close button only appears while hovering or focusing the item", () => {
  const remove = styles.match(/\.workspace-remove\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(remove, "workspace remove styles must exist");
  assert.match(remove, /opacity:\s*0/);
  assert.match(remove, /visibility:\s*hidden/);
  const reveal = styles.match(/\.workspace-item:hover \.workspace-remove,\s*\n\.workspace-item:focus-visible \.workspace-remove\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(reveal, "workspace remove must be revealed on hover");
  assert.match(reveal, /opacity:\s*1/);
  assert.match(reveal, /visibility:\s*visible/);
  assert.doesNotMatch(app, /<span>新建工作区<\/span>/);
});

test("workspaces are created from a picked local folder", () => {
  // Adding a workspace requires picking a real directory first.
  const addWorkspace = app.match(/async function addWorkspace\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(addWorkspace, "addWorkspace must exist");
  assert.match(addWorkspace, /await window\.termbeacon\.pickCwd\(\)/);
  assert.match(addWorkspace, /isValidCwd\(picked\)/);
  // The folder name becomes the default workspace title.
  assert.match(addWorkspace, /folderNameFromPath\(picked\)/);
  assert.match(addWorkspace, /name:\s*folderName \|\| `工作区 \$\{workspaces\.length \+ 1\}`/);
  // The picked folder is stored on the workspace and seeds its first terminal.
  assert.match(addWorkspace, /cwd:\s*picked/);
  assert.match(addWorkspace, /newTerminal\(terminals\.length \+ 1, defaultShell, picked\)/);
});

test("folder names are derived from windows and posix paths", () => {
  const folderName = app.match(/function folderNameFromPath\(path: string\): string \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(folderName, "folderNameFromPath must exist");
  assert.match(folderName, /PATH_SEPARATORS/);
});

test("terminals spawn with the fitted size instead of a hardcoded grid", () => {
  // A PTY created at 120x32 while xterm renders at the real container size
  // makes TUI apps paint at wrong coordinates until the first resize — the
  // "garbled right panel that a window resize fixes" bug.
  const mount = app.match(/const node = terminalNodes\.current\.get\(terminal\.id\);([\s\S]*?)await window\.termbeacon\.createTerminal\(\{([\s\S]*?)\}\);/)?.[0];
  assert.ok(mount, "terminal mount + createTerminal block must exist");
  assert.match(mount, /fit\.fit\(\)/);
  assert.doesNotMatch(mount, /cols:\s*120,\s*\n\s*rows:\s*32/);
  assert.match(mount, /cols,\s*\n\s*rows,/);
  assert.match(app, /sentSizes\.current\.set\(terminal\.id, `\$\{cols\}x\$\{rows\}`\)/);
  // Restarting a stopped terminal uses the live view size too.
  const restart = app.match(/function restartTerminal\(id: string\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(restart, "restartTerminal must exist");
  assert.match(restart, /term\.cols > 1 \? term\.cols : 120/);
  assert.match(restart, /term\.rows > 1 \? term\.rows : 32/);
});

test("TUI output keeps native LF handling", () => {
  assert.match(app, /convertEol:\s*false/);
  assert.doesNotMatch(app, /convertEol:\s*true/);
});

test("terminal paste shortcuts read the system clipboard and use xterm paste", () => {
  assert.match(app, /readClipboardText\(\): Promise<string>/);
  assert.match(app, /term\.attachCustomKeyEventHandler\(\(event\) =>/);
  assert.match(app, /if \(event\.type !== "keydown"\) return true/);
  assert.match(app, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(app, /key === "insert" && event\.shiftKey/);
  assert.match(app, /window\.termbeacon\.readClipboardText\(\)/);
  assert.match(app, /term\.paste\(text\)/);
  assert.match(fs.readFileSync(path.join(__dirname, "../src/main/preload.cjs"), "utf8"), /readClipboardText: \(\) => ipcRenderer\.invoke\("clipboard:read-text"\)/);
});

test("alternate-screen repaint output is isolated from scrollback", () => {
  const screen = fs.readFileSync(path.join(__dirname, "../src/renderer/terminal-screen.ts"), "utf8");
  assert.match(screen, /1049/);
  assert.match(screen, /1047/);
  assert.match(screen, /47/);
  assert.match(app, /splitScreenOutput\(event\.data/);
  assert.match(app, /if \(!event\.replay && screen\.normalData\)/);
});

test("OpenCode wheel reports are coalesced per animation frame", () => {
  assert.match(app, /function isWheelMouseReport\(data: string\)/);
  assert.match(app, /6\[45\]/);
  assert.match(app, /requestAnimationFrame\(\(\) =>/);
  assert.match(app, /detected !== "opencode"/);
  assert.match(app, /writeOpenCodeInput\(terminal\.id, data/);
});

test("pty resizes are deduped and debounced", () => {
  // Same-size resizes must never reach the pty twice.
  const applyPtySize = app.match(/function applyPtySize\(id: string, cols: number, rows: number\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(applyPtySize, "applyPtySize must exist");
  assert.match(applyPtySize, /sentSizes\.current\.get\(id\) === key/);
  assert.match(applyPtySize, /window\.termbeacon\.resize/);
  // Container resize bursts collapse into one trailing pty resize.
  const schedulePtyFit = app.match(/function schedulePtyFit\(id: string, delayMs = 50\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(schedulePtyFit, "schedulePtyFit must exist");
  assert.match(schedulePtyFit, /clearTimeout\(existing\)/);
  assert.match(schedulePtyFit, /window\.setTimeout/);
  // Every resize path goes through the debounced scheduler.
  const resizeEffect = app.match(/const schedule = \(\) => \{([\s\S]*?)\};/)?.[1];
  assert.ok(resizeEffect, "resize observer effect must exist");
  assert.match(resizeEffect, /schedulePtyFit\(activeId\)/);
});

test("terminals created in a workspace start in the workspace folder", () => {
  const addTerminal = app.match(/function addTerminal\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(addTerminal, "addTerminal must exist");
  assert.match(addTerminal, /activeWorkspace\?\.cwd/);
  assert.match(addTerminal, /isValidCwd\(workspaceCwd\) \? workspaceCwd : DEFAULT_CWD/);
});

test("removing the last terminal restores focus to the replacement xterm", () => {
  const removeTerminal = app.match(/async function removeTerminal\(id: string\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(removeTerminal, "removeTerminal must exist");
  assert.match(removeTerminal, /setActiveId\(replacement\.id\);[\s\S]*focusTerminalView\(replacement\.id\);/);
  assert.match(removeTerminal, /const nextActiveId = id === activeId \? remaining\[0\] : activeId/);
  assert.match(removeTerminal, /if \(nextActiveId\) focusTerminalView\(nextActiveId\);/);
  const mount = app.match(/const node = terminalNodes\.current\.get\(terminal\.id\);([\s\S]*?)\/\/ Fit before creating the PTY/)?.[1];
  assert.ok(mount, "terminal mount focus block must exist");
  assert.match(mount, /term\.open\(node\)/);
  assert.match(mount, /terminal\.id === activeId && !settingsOpen/);
  assert.match(mount, /term\.focus\(\)/);
});

test("confirmations use the native dialog instead of window.confirm", () => {
  // Electron's built-in confirm leaves document.hasFocus() false on Windows, so
  // every keystroke is dropped after dismissing it until the user switches
  // windows. All confirmations must go through the main-process message box.
  assert.doesNotMatch(app, /window\.confirm\(/);
  assert.match(app, /window\.termbeacon\.confirm\(\{/);
  assert.match(app, /const confirmed = await window\.termbeacon\.confirm\(\{[\s\S]*?cancelLabel: t\("取消"\)/);
  assert.match(app, /onRestartHost=\{async \(\) => \{[\s\S]*?window\.termbeacon\.confirm\(\{/);
  const preload = fs.readFileSync(path.join(__dirname, "../src/main/preload.cjs"), "utf8");
  assert.match(preload, /confirm: \(request\) => ipcRenderer\.invoke\("dialog:confirm", request\)/);
  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const handler = main.match(/ipcMain\.handle\("dialog:confirm", async \(_event, request\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(handler, "dialog:confirm handler must exist");
  assert.match(handler, /BrowserWindow\.fromWebContents\(_event\.sender\) \?\? mainWindow/);
  assert.match(handler, /noLink: true/);
  assert.match(handler, /return result\.response === 0;/);
});

test("hydration points activeId at the seeded terminal on first launch", () => {
  // On a fresh profile App renders with a throwaway terminal from useState. If
  // hydration seeds the workspace with a different one but leaves activeId
  // stale, deleting the only terminal skips the replacement branch and leaves
  // the workspace empty -- the sidebar loses its last terminal.
  const hydrate = app.match(/if \(state\.terminals\.length === 0\) \{([\s\S]*?)\n      \} else \{/)?.[1];
  assert.ok(hydrate, "empty-state hydration branch must exist");
  assert.match(hydrate, /const freshTerminalId = freshTerminal\?\.id;/);
  assert.match(hydrate, /terminalIds: freshTerminalId \? \[freshTerminalId\] : \[\]/);
  assert.match(hydrate, /if \(freshTerminalId\) setActiveId\(freshTerminalId\);/);
});

test("workspace titles mirror the folder name until the user renames them", () => {
  // Renaming pins the name so a folder change cannot clobber it.
  const renameWorkspace = app.match(/function renameWorkspace\(id: string, name: string\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(renameWorkspace, "renameWorkspace must exist");
  assert.match(renameWorkspace, /namePinned:\s*true/);
  // Hydration only re-derives names for unpinned workspaces with a folder.
  assert.match(app, /workspace\.namePinned \|\| !workspace\.cwd/);
  assert.match(app, /folderNameFromPath\(workspace\.cwd\)/);
});

test("generated terminal titles translate without changing pinned names", () => {
  const display = app.match(/function displayTerminalTitle\(terminal: TerminalInstance\): string \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(display, "displayTerminalTitle must exist");
  assert.match(display, /if \(terminal\.titlePinned\) return terminal\.title/);
  assert.match(display, /终端\|Terminal/);
});

test("Claude task titles stay in the sidebar while OSC status labels are ignored", () => {
  assert.match(app, /function isClaudeStatusTitle\(title: string\): boolean/);
  assert.match(app, /return \/\^\(\?:\[◐◑✳\]\\s\*\)\?Claude Code\$\/i\.test/);
  assert.match(app, /if \(isClaudeStatusTitle\(event\.title\)\) return;/);
  assert.match(app, /if \(event\.current === "working" && prompt\) syncClaudeTaskTitle\(event\.terminalId, prompt\)/);
  assert.match(app, /taskTitles\.current\.set\(id, title\)/);
  assert.match(app, /titlePinned: false/);
});

test("settings occupy an independent page while terminal views remain mounted", () => {
  const settings = fs.readFileSync(path.join(__dirname, "../src/renderer/SettingsPage.tsx"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/settings.css"), "utf8");
  assert.match(app, /settingsOpen && <SettingsPage/);
  assert.match(app, /settingsOpen \? "settings-hidden"/);
  assert.match(app, /className="terminal-stage" ref=\{terminalStage\}/);
  assert.doesNotMatch(app, /settings-popover/);
  assert.match(css, /\.workspace\.settings-hidden \{ display: none; \}/);
  assert.match(settings, /aria-label=\{t\("设置分类"\)\}/);
  assert.match(settings, /返回终端/);
  assert.match(settings, /常规/);
  assert.match(settings, /Agent CLI/);
});

test("generic input only treats a complete CLI command as an agent launch", () => {
  assert.match(launch, /normalized === command\s*\|\|\s*normalized\.startsWith\(`\$\{command\} `\)/);
  assert.doesNotMatch(launch, /command\.startsWith\(normalized\)/);
  assert.match(app, /isAgentLaunchInput\(candidate/);
});
