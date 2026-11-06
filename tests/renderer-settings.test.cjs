const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../src/renderer/App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");

test("settings icon uses a conventional gear", () => {
  const icon = app.match(/function SettingsIcon\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(icon, "SettingsIcon must exist");
  assert.equal((icon.match(/<path /g) || []).length, 1);
  assert.equal((icon.match(/<circle /g) || []).length, 1);
  assert.match(icon, /M12\.22 2/);
});

test("sidebar controls expose collapse and a visible new-terminal action", () => {
  assert.match(app, /title="隐藏工作栏"/);
  assert.match(app, /title="展开工作栏"/);
  assert.match(app, /aria-label="新建终端"><PlusIcon\s*\/>/);
});

test("workspace removal remains available for the active workspace", () => {
  assert.match(app, /workspaces\.length > 1 && <span className="workspace-remove"/);
  assert.doesNotMatch(app, /workspace\.id !== activeWorkspaceId && <span className="workspace-remove"/);
});

test("settings popover is mounted outside the clipped sidebar", () => {
  const footer = app.match(/<div className="sidebar-footer">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(footer, "sidebar footer must exist");
  assert.equal(footer.includes('className="settings-popover"'), false);
  const sidebarEnd = app.indexOf("</aside>");
  const popoverStart = app.indexOf('className="settings-popover"');
  assert.ok(sidebarEnd >= 0 && popoverStart > sidebarEnd, "popover must follow the sidebar in the app shell");
});

test("settings popover uses app-level positioning beside the sidebar", () => {
  const rule = styles.match(/\.settings-popover\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(rule, "settings popover styles must exist");
  assert.match(rule, /left:\s*calc\(var\(--sidebar-width\) - 226px\)/);
  assert.match(rule, /bottom:\s*47px/);
});
