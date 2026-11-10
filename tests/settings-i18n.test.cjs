const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/renderer/settings-i18n.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exportsObject = {};
vm.runInNewContext(compiled, { exports: exportsObject });
const { settingsText: text, readSettingsLocale, saveSettingsLocale, describeSettingsUpdate, SETTINGS_LANGUAGE_KEY } = exportsObject;

test("settings language persists and defaults safely for missing or unsupported preferences", () => {
  const entries = new Map();
  const storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  assert.equal(readSettingsLocale(storage), "zh-CN");
  saveSettingsLocale(storage, "en");
  assert.equal(entries.get(SETTINGS_LANGUAGE_KEY), "en");
  assert.equal(readSettingsLocale(storage), "en");
  saveSettingsLocale(storage, "zh-CN");
  assert.equal(readSettingsLocale(storage), "zh-CN");
  storage.setItem(SETTINGS_LANGUAGE_KEY, "unsupported");
  assert.equal(readSettingsLocale(storage), "zh-CN");
  assert.equal(readSettingsLocale({ getItem() { throw new Error("blocked"); } }), "zh-CN");
  assert.doesNotThrow(() => saveSettingsLocale({ setItem() { throw new Error("blocked"); } }, "en"));
});

test("existing backend previews and progress translate without altering paths or versions", () => {
  const installPath = "C:\\用户\\未安装\\$&\\{version}\\releases";
  const preview = `在 ${installPath} 创建独立安装，固定版本 1.5.0。`;
  assert.equal(text("en", preview), `Create an isolated installation in ${installPath}, pinned to version 1.5.0.`);
  assert.equal(text("zh-CN", preview), preview);
  assert.equal(text("en", "正在安装 Claude Code 2.1.319…"), "Installing Claude Code 2.1.319…");
  assert.equal(text("en", "将新启动的 Pi 切换到上一托管版本 1.4.0安装。"), "Use the previous managed version 1.4.0 for new Pi sessions.");
  assert.equal(text("en", "版本验证失败，期望 1.5.0，实际 未知；当前入口保持原版本。"), "Version verification failed: expected 1.5.0, got unknown. The current launcher keeps its previous version.");
  assert.equal(text("en", "{name} 管理", { name: "Claude Code" }), "Manage Claude Code");
  assert.equal(text("zh-CN", "回退到 {version}", { version: "1.4.0" }), "回退到 1.4.0");
});

test("unknown diagnostic output and commands are preserved verbatim", () => {
  for (const original of ["npm ERR! 在 安装脚本 中失败", "npm install --prefix C:\\用户\\未安装", "C:\\未找到\\codex.cmd", "new host message", ""]) {
    assert.equal(text("en", original), original);
    assert.equal(text("zh-CN", original), original);
  }
});

test("terminal workspace labels use the selected language", () => {
  assert.equal(text("en", "工作区"), "Workspaces");
  assert.equal(text("en", "终端"), "Terminals");
  assert.equal(text("en", "就绪"), "Ready");
  assert.equal(text("en", "终端 {index}", { index: 1 }), "Terminal 1");
  assert.equal(text("zh-CN", "终端 {index}", { index: 1 }), "终端 1");
});

test("settings update messages include localized retries, downloads, and nested errors", () => {
  assert.equal(describeSettingsUpdate("en", { type: "downloading", percent: 52.7 }, true), "Downloading update 53%");
  assert.equal(describeSettingsUpdate("zh-CN", { type: "downloaded", version: "0.2.0" }, true), "新版本 0.2.0 已下载，重启应用即可安装");
  assert.equal(describeSettingsUpdate("en", { type: "checking", message: "连接 GitHub 暂时失败，正在重试（2/3）…" }, true), "Could not connect to GitHub. Retrying (2/3)…");
  assert.equal(describeSettingsUpdate("en", { type: "error", message: "GitHub 更新服务器响应超时（HTTP 504），请稍后重试。" }, true), "Update check failed: The GitHub update server timed out (HTTP 504). Please try again later.");
  assert.equal(describeSettingsUpdate("en", { type: "error" }, true), "Update check failed: Unknown error");
  assert.match(describeSettingsUpdate("en", null, false), /Development mode/);
});
