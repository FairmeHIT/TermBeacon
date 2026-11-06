/**
 * Build the distributable and make sure artifacts end up in the in-repo
 * release/ directory. On this Windows machine a filter driver intermittently
 * leaves delete-pending EBUSY locks on freshly built files inside the project
 * tree (HANDOFF 6.8/6.11). Strategy: build into a scratch directory outside
 * the project, then COPY (not move) the artifacts into release/, which is not
 * affected by the lock. The locked scratch directory is renamed aside and
 * best-effort cleaned; a later reboot clears the residual delete-pending
 * state.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, renameSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const releaseDir = resolve(root, "release");
const scratch = "D:/temp-termbeacon-build";

console.log("[dist] building into scratch dir:", scratch);
const command = process.platform === "win32"
  ? `npx electron-builder --win --config electron-builder.config.cjs --config.directories.output=${scratch}`
  : `npx electron-builder --win --config electron-builder.config.cjs --config.directories.output=${scratch}`;
execFileSync(command, { stdio: "inherit", shell: true });

mkdirSync(releaseDir, { recursive: true });
for (const entry of readdirSync(scratch)) {
  const from = resolve(scratch, entry);
  const to = resolve(releaseDir, entry);
  try {
    cpSync(from, to, { recursive: true });
    console.log("[dist] copied:", entry);
  } catch (error) {
    console.warn(`[dist] could not copy ${entry}: ${error.code ?? error.message} (the file is lock-remnant debris; skipping)`);
    rmSync(from, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  }
}

// Best-effort cleanup of the scratch tree; leave a renamed remnant when the
// driver still holds delete-pending handles, so it does not break the next run.
try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  console.log("[dist] scratch cleaned");
} catch {
  const stale = scratch + "-locked";
  try { if (existsSync(stale)) rmSync(stale, { recursive: true, force: true, maxRetries: 3 }); } catch { /* give up on older remnant */ }
  try { renameSync(scratch, stale); console.log("[dist] scratch renamed aside as", stale, "(will clean after reboot)"); } catch (error) {
    console.warn("[dist] scratch could not be renamed:", error.code, "- next build will retry into it");
  }
}

console.log("[dist] artifacts in:", releaseDir);
