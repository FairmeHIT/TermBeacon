/** Build into a fresh scratch directory, then fail closed on copy errors. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const release = join(root, "release");
const base = resolve(process.env.TERMBEACON_BUILD_DIR || tmpdir());
const scratch = join(base, `termbeacon-build-${version}-${randomUUID()}`);
if (relative(base, scratch).startsWith("..") || scratch === base) throw new Error("Invalid scratch directory");
mkdirSync(scratch, { recursive: true });
console.log("[dist] building in", scratch);
try {
  execFileSync(process.execPath, [join(root, "node_modules/electron-builder/out/cli/cli.js"), "--win", "--publish", "never", "--config", "electron-builder.config.cjs", `--config.directories.output=${scratch}`], { cwd: root, stdio: "inherit", windowsHide: true });
  mkdirSync(release, { recursive: true });
  // Copy the manifest last. A failed copy can never advertise a ready release.
  for (const name of ["win-unpacked", `TermBeacon-${version}-setup.exe`, `TermBeacon-${version}-setup.exe.blockmap`, "latest.yml"]) {
    cpSync(join(scratch, name), join(release, name), { recursive: true, force: true });
    console.log("[dist] copied", name);
  }
} finally {
  // Only this invocation's freshly created child directory is eligible.
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); }
  catch (error) { console.warn(`[dist] scratch retained at ${scratch}: ${error.code}`); }
}
console.log("[dist] artifacts in", release);
