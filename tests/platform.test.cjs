const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { defaultCwd, defaultShell, isAbsoluteCwd, platformInfo } = require("../src/main/platform.cjs");

test("platform defaults use the current user's home directory and shell", () => {
  assert.equal(defaultCwd(), os.homedir());
  assert.equal(platformInfo().cwd, os.homedir());
  assert.equal(platformInfo().shell, defaultShell());
  assert.ok(defaultShell().length > 0);
});

test("absolute cwd validation follows the host platform", () => {
  assert.equal(isAbsoluteCwd(process.platform === "win32" ? "C:\\Users" : "/Users"), true);
  assert.equal(isAbsoluteCwd("relative/path"), false);
});

test("macOS fallback shell is zsh when SHELL is unavailable", () => {
  if (process.platform !== "darwin") return;
  assert.equal(defaultShell({}), "/bin/zsh");
});
