import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listPackage, extractFile } from "@electron/asar";

const root = resolve(import.meta.dirname, "..");
const releaseDir = join(root, "release");
const unpackedDir = join(releaseDir, "win-unpacked");
const resourcesDir = join(unpackedDir, "resources");
const appAsar = join(resourcesDir, "app.asar");
const errors = [];

function requireFile(label, file) {
  if (!existsSync(file) || !statSync(file).isFile()) errors.push(`${label}: ${file}`);
}

requireFile("unpacked executable", join(unpackedDir, "TermBeacon.exe"));
requireFile("application ASAR", appAsar);
requireFile("node-pty binary", join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node"));
requireFile("ConPTY binary", join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "win32-x64", "conpty.node"));
requireFile("ConPTY console helper", join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "win32-x64", "conpty_console_list.node"));
requireFile("opencode plugin resource", join(resourcesDir, "termbeacon-hooks", "opencode", "termbeacon.js"));
requireFile("Claude Hook resource", join(resourcesDir, "termbeacon-hooks", "termbeacon-hook.cjs"));

const setupFiles = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((name) => /^TermBeacon-[0-9]+\.[0-9]+\.[0-9]+-setup\.exe$/i.test(name))
  : [];
if (setupFiles.length === 0) errors.push(`installer executable: ${releaseDir}`);

if (existsSync(appAsar)) {
  const entries = new Set(listPackage(appAsar).map((entry) => entry.replace(/^\\/, "").replaceAll("\\", "/")));
  for (const required of [
    "dist/main/main.js",
    "dist/main/preload.cjs",
    "dist/main/pty-host.cjs",
    "dist/main/detection-engine.cjs",
    "dist/host-app/main.cjs",
    "dist/renderer/index.html",
    "package.json",
  ]) {
    if (!entries.has(required)) errors.push(`ASAR entry: ${required}`);
  }

  try {
    const packagedMain = extractFile(appAsar, "dist\\main\\main.js").toString("utf8");
    if (!packagedMain.includes("--termbeacon-pty-host")) {
      errors.push("packaged main is missing the packaged PTY host entry point");
    }
    const packaged = JSON.parse(extractFile(appAsar, "package.json").toString("utf8"));
    const latestPath = join(releaseDir, "latest.yml");
    if (existsSync(latestPath)) {
      const latest = readFileSync(latestPath, "utf8");
      if (!latest.includes(`version: ${packaged.version}`)) errors.push(`latest.yml version does not match packaged version ${packaged.version}`);
      const latestInstaller = latest.match(/^path:\s*(.+)$/m)?.[1]?.trim();
      if (latestInstaller && !existsSync(join(releaseDir, latestInstaller))) errors.push(`latest.yml installer is missing: ${latestInstaller}`);
    }
  } catch (error) {
    errors.push(`read packaged package.json: ${error.message}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[verify:dist] error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[verify:dist] ready: ${setupFiles.join(", ")}`);
}
