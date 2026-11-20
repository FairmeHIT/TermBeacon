const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../src/renderer/App.tsx"), "utf8");
const i18n = fs.readFileSync(path.join(__dirname, "../src/renderer/settings-i18n.ts"), "utf8");
const launch = fs.readFileSync(path.join(__dirname, "../src/main/agent-launch.cjs"), "utf8");
const sharedTypes = fs.readFileSync(path.join(__dirname, "../src/shared/types.ts"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");

test("brand header uses a beacon mark and only the product name", () => {
  const brandRow = app.match(/<div className="brand-row">([\s\S]*?)<\/div>\s*<section className="sidebar-section workspaces-section"/)?.[1];
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
  // Bottom-left inside the terminal frame: the 10px gutter plus the frame's
  // 10px inset keeps the button on the card's edge instead of over its text.
  assert.match(collapsed, /bottom:\s*20px/);
  assert.doesNotMatch(collapsed, /top:\s*20px/);
});

test("workspaces and terminals render as distinct labeled sections", () => {
  // Both sections live in the sidebar with their own headers and add actions.
  assert.match(app, /<section className="sidebar-section workspaces-section"/);
  assert.match(app, /<section className="sidebar-section terminals-section">/);
  assert.match(app, /<span className="sidebar-section-title">\{t\("工作区"\)\}<\/span>/);
  assert.match(app, /<span className="sidebar-section-title">\{t\("终端"\)\}<\/span>/);
  // The sections are visually separated by the draggable divider.
  const resizer = styles.match(/\.sidebar-section-resizer\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(resizer, "section resizer styles must exist");
  assert.match(resizer, /cursor:\s*row-resize/);
  // The workspace list is a vertical, scrollable list of folder cards.
  const list = styles.match(/\.workspace-list\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(list, "workspace list styles must exist");
  assert.match(list, /flex-direction:\s*column/);
  assert.match(list, /overflow-y:\s*auto/);
  const item = styles.match(/\.workspace-item\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(item, "workspace item styles must exist");
  // Two columns only: the action buttons float over the row, never reserving a
  // third column of blank space.
  assert.match(item, /grid-template-columns:\s*16px minmax\(0, 1fr\);/);
  const actions = styles.match(/\.workspace-actions\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(actions, "workspace actions styles must exist");
  assert.match(actions, /position:\s*absolute/);
  assert.doesNotMatch(item, /height:\s*26px/, "workspace items are cards, not one-row chips");
  assert.match(app, /aria-label=\{t\("添加工作区（选择本地文件夹）"\)\}><PlusIcon/);
  assert.match(app, /ref=\{workspaceStrip\}/);
});

test("workspace sections keep their own add actions next to the title", () => {
  // Each section header carries its own + button scoped to that section.
  const workspacesHeader = app.match(/<section className="sidebar-section workspaces-section"[\s\S]*?>((?:[^<]|<(?!\/section))*?)<\/section>/)?.[1];
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

test("terminal rows expose a pin toggle and a batch clean for unpinned terminals", () => {
  // The pin sits left of the remove button and flips rowPinned on click.
  const pin = app.match(/<span className=\{`terminal-pin \$\{terminal\.rowPinned \? "pinned" : ""\}`\}[\s\S]*?toggleRowPin\(terminal\.id\); \}\} title=\{terminal\.rowPinned \? t\("取消固定"\) : t\("固定"\)\}/)?.[0];
  assert.ok(pin, "terminal pin toggle must exist");
  const toggle = app.match(/function toggleRowPin\(id: string\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(toggle, "toggleRowPin must exist");
  assert.match(toggle, /rowPinned: !item\.rowPinned/);
  // Pin state persists with the rest of the terminal fields.
  assert.match(app, /rowPinned: terminal\.rowPinned === true,/);
  assert.match(sharedTypes, /rowPinned\?: boolean/);
  // The batch clean button only renders when unpinned terminals exist.
  assert.match(app, /workspaceTerminals\.some\(\(terminal\) => terminal\.rowPinned !== true\) && <button className="workspace-add terminal-batch-clean"/);
  const batch = app.match(/async function removeUnpinnedTerminals\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(batch, "removeUnpinnedTerminals must exist");
  // Only unpinned rows are targeted, and the action confirms first.
  assert.match(batch, /workspaceTerminals\.filter\(\(terminal\) => terminal\.rowPinned !== true\)/);
  assert.match(batch, /window\.termbeacon\.confirm\(/);
  // Pinned rows are exempt; the workspace keeps at least one terminal.
  const pinStyles = styles.match(/\.terminal-pin\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(pinStyles, "terminal pin styles must exist");
  assert.match(styles, /\.terminal-pin\.pinned\s*\{/);
  assert.match(styles, /\.terminal-batch-clean:hover\s*\{/);
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

test("Unicode 11 width tables are enabled with xterm's proposed API", () => {
  assert.match(app, /new Unicode11Addon\(\)/);
  assert.match(app, /unicode\.activeVersion = "11"/);
  // xterm throws while loading the addon unless proposed APIs are allowed.
  // That exception unmounted the whole app and left a blank window.
  assert.match(app, /allowProposedApi:\s*true/);
});

test("native title bar colors follow every app theme", () => {
  const chrome = app.match(/const themeChrome: Record<Theme, \{ caption: string; text: string; border: string \}> = \{([\s\S]*?)\n\};/)?.[1];
  assert.ok(chrome, "themeChrome palette must exist");
  for (const theme of ["dark", "light", "sepia"]) {
    assert.match(chrome, new RegExp(`${theme}: \\{ caption: "#[0-9a-f]{6}", text: "#[0-9a-f]{6}", border: "#[0-9a-f]{6}" \\}`));
  }
  assert.match(app, /setNativeTheme\(\{\s*\n\s*mode:[\s\S]*?\.\.\.themeChrome\[theme\]/);
  // The main process must fall back gracefully when DWM rejects the call.
  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  assert.match(main, /DwmSetWindowAttribute\(\$h, 35/);
  assert.match(main, /DwmSetWindowAttribute\(\$h, 36/);
  assert.match(main, /process\.platform !== "win32"/);
});

test("light terminal palettes keep PowerShell's ANSI colors readable", () => {
  // PSReadLine paints the command being typed with bright yellow (ESC[93m) and
  // turns arguments white (ESC[37m). xterm's built-in ANSI ramp targets dark
  // canvases, so those defaults fall to roughly 1.1:1 on the warm-paper and
  // light backgrounds and the typed command nearly disappears. Light themes
  // therefore define every slot explicitly.
  const block = app.match(/const terminalThemes: Record<Theme, TerminalTheme> = \{([\s\S]*?)\n\};/)?.[1];
  assert.ok(block, "terminalThemes palette must exist");
  const slots = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  const luminance = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [value >> 16 & 255, value >> 8 & 255, value & 255].map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
  };
  for (const theme of ["light", "sepia"]) {
    const body = block.match(new RegExp(`\\n  ${theme}: \\{([\\s\\S]*?)\\n  \\},`))?.[1];
    assert.ok(body, `${theme} palette must exist`);
    const values = Object.fromEntries([...body.matchAll(/(\w+): "(#[0-9a-f]{6})"/g)].map((match) => [match[1], match[2]]));
    for (const slot of slots) {
      assert.match(values[slot] || "", /^#[0-9a-f]{6}$/, `${theme}.${slot} must be defined`);
      assert.ok(contrast(values[slot], values.background) >= 4.5, `${theme}.${slot} must reach 4.5:1 against its background`);
    }
    // The default cursor accent is black and the default selection is white at
    // 30% opacity; both are unusable on a light canvas.
    assert.match(body, /cursorAccent: "#[0-9a-f]{6}"/);
    assert.match(body, /selectionBackground: "rgba\(/);
  }
  // The dark palette keeps xterm's ramp, which already suits it.
  for (const theme of ["dark"]) {
    const line = block.match(new RegExp(`\\n  ${theme}: \\{[^\\n]*\\},`))?.[0];
    assert.ok(line, `${theme} palette must stay compact`);
    assert.doesNotMatch(line, /brightYellow/);
  }
});

test("the appearance palette is limited to the three maintained themes", () => {
  const settings = fs.readFileSync(path.join(__dirname, "../src/renderer/SettingsPage.tsx"), "utf8");
  const settingsStyles = fs.readFileSync(path.join(__dirname, "../src/renderer/settings.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
  assert.match(app, /export type ThemeSetting = "dark" \| "light" \| "sepia";/);
  assert.match(app, /const THEME_SETTINGS: ThemeSetting\[\] = \["dark", "sepia", "light"\];/);
  const options = settings.match(/const THEME_OPTIONS:[\s\S]*?\n\];/)?.[0];
  assert.ok(options, "theme options must exist");
  const values = [...options.matchAll(/value: "(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ["dark", "sepia", "light"]);
  // Retired palettes must not leave a theme block or a settings preview behind.
  for (const theme of ["midnight", "forest"]) {
    assert.doesNotMatch(styles, new RegExp(`data-theme="${theme}"`));
    assert.doesNotMatch(settingsStyles, new RegExp(`appearance-preview\\.${theme}`));
    assert.doesNotMatch(html, new RegExp(`\\b${theme}:\\s*"#`));
  }
  assert.doesNotMatch(settingsStyles, /appearance-preview\.system/);
});

test("status lamps stay legible and distinct across the three themes", () => {
  const themeBlock = (theme) => theme === "dark"
    ? styles.match(/:root \{([\s\S]*?)\n\}/)?.[1]
    : styles.match(new RegExp(`:root\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1];
  const luminance = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [value >> 16 & 255, value >> 8 & 255, value & 255].map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const saturation = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [value >> 16 & 255, value >> 8 & 255, value & 255].map((channel) => channel / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    return max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  };
  const read = (body, name) => body.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))?.[1];
  const statuses = ["ready", "working", "completed", "awaiting", "error", "stopped"];
  for (const theme of ["dark", "light", "sepia"]) {
    const body = themeBlock(theme);
    assert.ok(body, `${theme} palette must exist`);
    const backgrounds = ["app-bg", "panel-bg", "panel-soft", "panel-active"].map((name) => {
      const value = read(body, name);
      assert.match(value || "", /^#[0-9a-f]{6}$/, `${theme}.${name} must be defined`);
      return value;
    });
    const colors = {};
    for (const state of statuses) {
      const value = read(body, `status-${state}`);
      assert.match(value || "", /^#[0-9a-f]{6}$/, `${theme}.status-${state} must be defined`);
      colors[state] = value;
      // Solid fills must stay above 4.5:1; the hollow stopped ring may sit at
      // the non-text 3:1 floor because its outline is still a visible shape.
      const minimum = state === "stopped" ? 3 : 4.5;
      const lowest = Math.min(...backgrounds.map((background) => contrast(value, background)));
      assert.ok(lowest >= minimum, `${theme}.status-${state} must reach ${minimum}:1 (got ${lowest.toFixed(2)})`);
    }
    // The original complaint: ready and working looked like the same lamp.
    // Keep ready neutral and working clearly saturated, then let the animated
    // ring in the CSS carry the remaining difference.
    assert.ok(saturation(colors.ready) <= 0.3, `${theme}.status-ready must stay neutral`);
    assert.ok(saturation(colors.working) >= 0.5, `${theme}.status-working must stay saturated`);
  }
  assert.match(styles, /\.status-dot\.stopped \{[^}]*background: transparent/);
  assert.match(styles, /\.status-dot::after \{[^}]*border: 1px solid currentColor/);
  assert.match(styles, /\.status-dot\.working::after \{[^}]*animation: status-ping/);
  assert.match(styles, /\.workspace-lamp \{[^}]*width: 8px/);
});

test("workspaces surface the most urgent terminal state as a lamp", () => {
  // A task that finished (green) or stalled (amber) in a background workspace
  // must be visible from the workspace list, not only from its terminal row.
  assert.match(app, /const WORKSPACE_LAMP_PRIORITY: AgentState\[\] = \["error", "awaiting-input", "completed-unseen", "working"\]/);
  const memo = app.match(/const workspaceLampStates = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[workspaces, terminals\]\);/)?.[1];
  assert.ok(memo, "workspace lamp memo must exist");
  assert.match(memo, /WORKSPACE_LAMP_PRIORITY\.find/);
  // The lamp reuses the terminal palette and sits on the folder glyph, so the
  // row keeps its three-column grid and the close button never shifts.
  assert.match(app, /\{lamp && <span className=\{`workspace-lamp status-dot \$\{stateClass\[lamp\]\}`\} role="img" aria-label=\{t\(stateLabel\[lamp\]\)\} \/>\}/);
  const glyph = styles.match(/\.workspace-glyph \{([\s\S]*?)\}/)?.[1];
  assert.ok(glyph, "workspace glyph styles must exist");
  assert.match(glyph, /position: relative/);
  const lamp = styles.match(/\.workspace-lamp \{([\s\S]*?)\}/)?.[1];
  assert.ok(lamp, "workspace lamp styles must exist");
  assert.match(lamp, /position: absolute/);
  assert.match(lamp, /margin: 0/);
  // Opening a workspace shows its terminal, so its "finished" lamp clears too.
  const selectWorkspace = app.match(/function selectWorkspace\(id: string\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(selectWorkspace, "selectWorkspace must exist");
  assert.match(selectWorkspace, /markTerminalViewed\(nextTerminalId\)/);
  const selectTerminal = app.match(/function selectTerminal\(id: string\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.match(selectTerminal, /markTerminalViewed\(id\)/);
});

test("workspaces open their folder in the system file manager", () => {
  // The row action hands the workspace folder to Explorer through the main
  // process; it must not switch workspaces or paste the path into a terminal.
  assert.match(app, /\{isValidCwd\(workspace\.cwd\) && <span className="workspace-open"/);
  assert.match(app, /void openWorkspaceFolder\(workspace\)/);
  const open = app.match(/async function openWorkspaceFolder\(workspace: Workspace\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(open, "openWorkspaceFolder must exist");
  assert.match(open, /window\.termbeacon\.openFolder\(workspace\.cwd\)/);
  assert.match(open, /window\.termbeacon\.showMessage\(\{\s*\n\s*type: "error"/);
  const preload = fs.readFileSync(path.join(__dirname, "../src/main/preload.cjs"), "utf8");
  assert.match(preload, /openFolder: \(target\) => ipcRenderer\.invoke\("folder:open", target\)/);

  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const handler = main.match(/ipcMain\.handle\("folder:open", async \(_event, target: unknown\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(handler, "folder:open handler must exist");
  // Only existing directories may reach shell.openPath, which would otherwise
  // launch documents and executables too.
  assert.match(handler, /path\.isAbsolute\(target\)/);
  assert.match(handler, /\(await stat\(target\)\)\.isDirectory\(\)/);
  assert.match(handler, /await shell\.openPath\(target\)/);
  assert.match(handler, /failure \? \{ ok: false, message: failure \} : \{ ok: true \}/);

  const button = styles.match(/\.workspace-open \{([\s\S]*?)\}/)?.[1];
  assert.ok(button, "workspace open styles must exist");
  // The folder action stays hidden until the row is hovered or focused, just
  // like the close button, so idle rows carry no stray glyphs.
  assert.match(button, /opacity:\s*0/);
  assert.match(button, /visibility:\s*hidden/);
  const reveal = styles.match(/\.workspace-item:hover \.workspace-open,\s*\n\.workspace-item:focus-visible \.workspace-open\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(reveal, "workspace open must be revealed on hover");
  assert.match(reveal, /opacity:\s*1/);
  assert.match(reveal, /visibility:\s*visible/);
  assert.match(styles, /\.workspace-open:hover \{ color: var\(--accent\); \}/);
});

test("the terminal stage is framed like the sidebar's panels", () => {
  // Claude Code, Pi and plain shells draw no chrome of their own, so the stage
  // supplies both the frame and the inner inset; without it their output ran
  // straight into the window edge and read as a different surface from the
  // sidebar. opencode keeps its own box inside this one.
  const root = styles.match(/:root \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(root, "root theme variables must exist");
  assert.match(root, /--terminal-frame-gutter: 10px/);
  assert.match(root, /--terminal-frame-inset: 10px/);
  assert.match(root, /--terminal-frame-radius: 10px/);

  const stage = styles.match(/\.terminal-stage \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(stage, "terminal stage styles must exist");
  assert.match(stage, /margin: var\(--terminal-frame-gutter\)/);
  assert.match(stage, /border: 1px solid var\(--border\)/);
  assert.match(stage, /border-radius: var\(--terminal-frame-radius\)/);

  // xterm measures its host, so the inset must live on the host: padding on the
  // stage would be ignored by the absolutely positioned host and would not
  // shrink the reported grid either.
  const host = styles.match(/\.terminal-host \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(host, "terminal host styles must exist");
  assert.match(host, /inset: var\(--terminal-frame-inset\)/);

  // The gutter takes the sidebar's surface so the two panels read as siblings.
  const workspace = styles.match(/\n\.workspace \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(workspace, "workspace styles must exist");
  assert.match(workspace, /background: var\(--panel-bg\)/);
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

test("new terminals launch the configured default agent", () => {
  const settings = fs.readFileSync(path.join(__dirname, "../src/renderer/SettingsPage.tsx"), "utf8");
  // Codex is the out-of-the-box default, and the choice is persisted with the
  // rest of the terminal preferences.
  assert.match(app, /const DEFAULT_NEW_TERMINAL_AGENT: AgentType = "codex"/);
  assert.match(app, /defaultNewTerminalAgent,\s*\n\s*autoResumeOnStart,\s*\n\s*opencodeThemeSync,\s*\n\s*sidebarWidth,/);
  assert.match(app, /\}, \[terminals, workspaces, activeId, activeWorkspaceId, tasks, defaultShell, defaultNewTerminalAgent, autoResumeOnStart, opencodeThemeSync, sidebarWidth, workspaceRatio, hydrated\]\)/);
  const addTerminal = app.match(/async function addTerminal\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(addTerminal, "addTerminal must exist");
  assert.match(addTerminal, /if \(defaultNewTerminalAgent !== "generic"\)/);
  assert.match(addTerminal, /await launchCli\(defaultNewTerminalAgent, cwd\)/);
  assert.match(addTerminal, /type: "error"/);
  assert.match(app, /newTerminalAgent=\{defaultNewTerminalAgent\}/);
  assert.doesNotMatch(app, /codexArgs/);
  assert.match(settings, /htmlFor="settings-new-terminal"/);
  assert.doesNotMatch(settings, /codex-args/);
  assert.match(settings, /props\.onNewTerminalAgent\(event\.target\.value as AgentType\)/);
  assert.match(i18n, /"New terminal launches"/);
  assert.match(i18n, /"Plain shell"/);
});

test("startup recovery resumes only exact saved sessions, once, and after a fresh shell", () => {
  const settings = fs.readFileSync(path.join(__dirname, "../src/renderer/SettingsPage.tsx"), "utf8");
  // The preference is persisted and exposed as an accessible switch.
  assert.match(sharedTypes, /autoResumeOnStart\?: boolean/);
  assert.match(app, /const \[autoResumeOnStart, setAutoResumeOnStart\] = useState\(true\)/);
  assert.match(app, /autoResumeOnStart=\{autoResumeOnStart\} onAutoResumeOnStart=\{setAutoResumeOnStart\}/);
  assert.match(settings, /role="switch"/);
  assert.match(settings, /aria-checked=\{props\.autoResumeOnStart\}/);
  assert.match(settings, /props\.onAutoResumeOnStart\(!props\.autoResumeOnStart\)/);
  assert.match(i18n, /"Resume sessions on startup"/);
  // Older state files default to enabled; the pending set is built from exact
  // session ids and the active terminal is resumed first.
  assert.match(app, /const restoredAutoResume = state\.autoResumeOnStart !== false/);
  assert.match(app, /autoResumeCandidates\(state\.terminals, restoredAutoResume\)/);
  assert.match(app, /autoResumeIds\.unshift\(state\.activeTerminalId\)/);
  // Attaching to a still-live host must never replay a resume command; only a
  // restored terminal that needed a brand-new PTY enters the queue.
  assert.match(app, /if \(restored && !existing && autoResume\) queueAutoResume\(terminal\.id\)/);
  // Background recovery must be serialized and must not guess a session.
  assert.match(app, /autoResumeTimer\.current = window\.setTimeout\(runAutoResumeQueue, AUTO_RESUME_INTERVAL_MS\)/);
  assert.match(app, /options\.auto && spec\.mode !== "session-id"/);
  assert.match(app, /autoResumePending\.current\.delete\(terminal\.id\)/);
});

test("opencode theme sync is persisted and exposed as an opt-out switch", () => {
  const settings = fs.readFileSync(path.join(__dirname, "../src/renderer/SettingsPage.tsx"), "utf8");
  assert.match(sharedTypes, /opencodeThemeSync\?: boolean/);
  assert.match(app, /const \[opencodeThemeSync, setOpencodeThemeSync\] = useState\(true\)/);
  assert.match(app, /opencodeThemeSync=\{opencodeThemeSync\} onOpencodeThemeSync=\{setOpencodeThemeSync\}/);
  assert.match(app, /setOpencodeThemeSync\(state\.opencodeThemeSync !== false\)/);
  // Both terminal creation paths send the concrete palette only when enabled.
  assert.equal((app.match(/\.\.\.\(opencodeThemeSync \? \{ theme \} : \{\}\)/g) || []).length, 2);
  assert.match(settings, /aria-checked=\{props\.opencodeThemeSync\}/);
  assert.match(settings, /props\.onOpencodeThemeSync\(!props\.opencodeThemeSync\)/);
  assert.match(i18n, /"Follow TermBeacon theme in opencode"/);
});

test("renderer tracks the CLI that owns a resumable session id", () => {
  assert.match(sharedTypes, /lastSessionAgent\?: AgentCliId/);
  assert.match(sharedTypes, /agentType: AgentCliId;/);
  assert.match(app, /lastSessionAgent: event\.agentType/);
  assert.match(app, /sessionAgent: terminal\.lastSessionAgent/);
  // Hydration must discard an id before a live host can replace it, and the
  // same guard runs again when state is serialized after a renderer reload.
  assert.match(app, /terminal\.lastSessionId && terminal\.lastSessionAgent === terminal\.agentType/);
  assert.match(app, /target\?\.lastSessionId !== undefined\s*\r?\n\s*&& target\.lastSessionAgent !== event\.agentType/s);
});

test("new shells announce the app appearance so opencode can follow the theme", () => {
  // opencode draws its own full-screen palette and never asks the terminal for
  // one on Windows, so the PTY needs the light/dark intent when it starts.
  const creates = [...app.matchAll(/createTerminal\(\{([\s\S]*?)\n\s*\}\)/g)].map((match) => match[1]);
  assert.equal(creates.length, 2);
  for (const body of creates) {
    assert.match(body, /appearance: DARK_THEMES\.includes\(theme\) \? "dark" : "light"/);
  }
  // The mount effect decides the appearance from the theme, so a stale closure
  // would keep spawning shells with the previous palette.
  assert.match(app, /\}, \[terminals, hydrated, platformInfo\.shell, activeId, settingsOpen, theme\]\);/);
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
  assert.match(app, /if \(event\.current === "working" && prompt\) syncAgentTaskTitle\(event\.terminalId, prompt\)/);
  assert.match(app, /taskTitles\.current\.set\(id, title\)/);
  assert.match(app, /titlePinned: false/);
});

test("Codex task titles use the submitted prompt as a stable fallback", () => {
  const sync = app.match(/function syncAgentTaskTitle\(id: string, prompt: string\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(sync, "syncAgentTaskTitle must exist");
  assert.match(sync, /agentType !== "claude" && agentType !== "codex"/);
  assert.match(app, /agentTypeByTerminal\.current\.get\(event\.terminalId\) === "codex"/);
  assert.match(app, /taskTitles\.current\.has\(event\.terminalId\)/);
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

// The alternate screen separates a shell line from an agent prompt. Without
// this gate, typing a CLI name into an OpenCode prompt resets the detector,
// and without the shell rewrite a restored terminal rejoins the shared server.
test("the launch rewrite follows the alternate screen and the restored label", () => {
  assert.match(app, /const interactive = alternateScreenByTerminal\.current\.get\(terminal\.id\) === true/);
  assert.match(app, /isAgentLaunchInput\(candidate, agentType, interactive\)/);
  assert.match(app, /withOpenCodeStandalone\(data, candidate, agentType, interactive\)/);
  assert.match(launch, /agentType !== "generic" && agentType !== "opencode"/);
});

test("workspaces collapse into a hidden group below the visible list", () => {
  const section = app.match(/<section className="sidebar-section workspaces-section"[\s\S]*?>((?:[^<]|<(?!\/section))*?)<\/section>/)?.[1];
  assert.ok(section, "workspaces section must exist");
  // The dropdown lives at the bottom of the block, after the scrolling list.
  const listIndex = section.indexOf('className="workspace-list"');
  const toggleIndex = section.indexOf("workspace-hidden-toggle");
  assert.ok(listIndex >= 0, "visible workspace list must exist");
  assert.ok(toggleIndex > listIndex, "hidden group toggle must sit below the visible list");
  assert.match(section, /aria-expanded=\{hiddenWorkspacesOpen\}/);
  assert.match(section, /aria-controls="hidden-workspaces"/);
  assert.match(section, /visibleWorkspaces\.map\(\(workspace\) => workspaceRow\(workspace, false\)\)/);
  assert.match(section, /hiddenWorkspaces\.map\(\(workspace\) => workspaceRow\(workspace, true\)\)/);
  // The sidebar renders creation order; nothing re-sorts it on each click.
  assert.doesNotMatch(app, /workspaceOrder|orderWorkspaceIds/);
  // The toggle is icon-only: no visible label, just the centered chevron.
  assert.doesNotMatch(section, /workspace-hidden-label|workspace-hidden-count|workspace-toggle-lamp/);
  assert.match(section, /<ChevronIcon open \/>/);
  // Both lists reuse one card so a workspace does not change shape on the way
  // down. The active row also offers to hide itself: collapsing it falls back
  // to the next surviving workspace so the terminal panel stays pointed.
  assert.match(app, /function workspaceRow\(workspace: Workspace, hidden: boolean\)/);
  assert.match(app, /: <span className="workspace-hide"/);
  assert.match(app, /<span className="workspace-unhide"/);
  const toggle = styles.match(/\.workspace-hidden-toggle\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(toggle, "hidden toggle styles must exist");
  assert.match(toggle, /cursor:\s*pointer/);
  assert.match(toggle, /justify-content:\s*center/);
  const hiddenList = styles.match(/\.workspace-hidden-list\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(hiddenList, "hidden list styles must exist");
  assert.match(hiddenList, /max-height/);
  assert.match(styles, /\.workspace-item-hidden\s*\{[^}]*opacity/);
});
