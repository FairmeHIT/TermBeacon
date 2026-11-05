const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Regression guard for a real outage: `osc-parser.cjs` was added to src/main
 * but not to the copy-runtime list, so the built pty-host crashed with
 * MODULE_NOT_FOUND on every launch and no terminal could start. tsc only
 * compiles .ts, so runtime .cjs modules must be copied by hand.
 *
 * Only modules actually required by runtime code are checked: some .cjs files
 * (cwd-utils, title-utils) exist solely for tests and are never loaded in a
 * packaged app.
 */
function requiredRuntimeModules() {
  const mainDir = path.join(__dirname, "..", "src", "main");
  const sources = ["pty-host.cjs", "main.ts"].map((file) => fs.readFileSync(path.join(mainDir, file), "utf8"));
  const found = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/require\("\.\/([\w-]+\.cjs)"\)/g)) found.add(match[1]);
  }
  return [...found];
}

test("every runtime .cjs required by main/pty-host is copied by copy-runtime.mjs", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "copy-runtime.mjs"), "utf8");
  const missing = requiredRuntimeModules().filter((file) => !script.includes(`"${file}"`));
  assert.deepStrictEqual(missing, [], `copy-runtime.mjs does not copy: ${missing.join(", ")}`);
});

test("built dist/main contains every required runtime module", () => {
  const distDir = path.join(__dirname, "..", "dist", "main");
  if (!fs.existsSync(distDir)) return; // build has not run in this environment
  const missing = requiredRuntimeModules().filter((file) => !fs.existsSync(path.join(distDir, file)));
  assert.deepStrictEqual(missing, [], `dist/main is missing: ${missing.join(", ")}`);
});
