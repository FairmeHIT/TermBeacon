const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
const host = fs.readFileSync(path.join(__dirname, "../src/host-app/main.cjs"), "utf8");

test("development builds use their own profile so the installed app can run side by side", () => {
  const block = main.match(/if \(!app\.isPackaged\) \{\r?\n([\s\S]*?)\r?\n\}/)?.[1];
  assert.ok(block, "the dev profile block must exist");
  assert.match(block, /app\.setPath\("userData", path\.join\(app\.getPath\("appData"\), "termbeacon-dev"\)\)/);
  // The profile must be chosen before the lock is requested, otherwise the dev
  // process still collides with the installed app and exits immediately.
  const profileAt = main.indexOf("termbeacon-dev");
  const lockAt = main.indexOf("app.requestSingleInstanceLock()");
  assert.ok(profileAt >= 0 && lockAt >= 0);
  assert.ok(profileAt < lockAt, "dev userData must be set before the single-instance lock");
});

test("the development PTY host keeps a separate Chromium profile", () => {
  assert.match(host, /app\.setPath\("userData", path\.join\(app\.getPath\("appData"\), "termbeacon-host-dev"\)\)/);
});
