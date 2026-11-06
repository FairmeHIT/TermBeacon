const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../src/renderer/App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");

test("settings icon uses three simple slider tracks and handles", () => {
  const icon = app.match(/function SettingsIcon\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(icon, "SettingsIcon must exist");
  assert.equal((icon.match(/<path d="M/g) || []).length, 3);
  assert.equal((icon.match(/<circle /g) || []).length, 3);
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
