import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listPackage, extractFile } from "@electron/asar";
import { validateReleaseArtifacts } from "./release-artifacts.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseDir = join(root, "release");
const unpackedDir = join(releaseDir, "win-unpacked");
const resourcesDir = join(unpackedDir, "resources");
const appAsar = join(resourcesDir, "app.asar");
const errors = [];
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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
requireFile("Pi extension resource", join(resourcesDir, "termbeacon-hooks", "pi", "termbeacon.js"));
requireFile("status reporter resource", join(resourcesDir, "termbeacon-hooks", "shared", "status-reporter.js"));

try { validateReleaseArtifacts(releaseDir, version); } catch (error) { errors.push(error.message); }

if (existsSync(appAsar)) {
  const entries = new Set(listPackage(appAsar).map((entry) => entry.replace(/^\\/, "").replaceAll("\\", "/")));
  for (const required of [
    "dist/main/main.js",
    "dist/main/preload.cjs",
    "dist/main/pty-host.cjs",
    "dist/main/detection-engine.cjs",
    "dist/main/hook-client.cjs",
    "dist/main/cli-manager.cjs",
    "dist/main/cli-runtime.cjs",
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
    if (packaged.version !== version) errors.push(`packaged version ${packaged.version} differs from source ${version}`);
    function checkBuiltFiles(directory, relative = "dist") {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) checkBuiltFiles(join(directory, entry.name), name);
        else if (!/\.(map|ts|tsx)$/.test(entry.name) && !readFileSync(join(directory, entry.name)).equals(extractFile(appAsar, name.replaceAll("/", "\\")))) errors.push(`packaged runtime differs from build: ${name}`);
      }
    }
    checkBuiltFiles(join(root, "dist"));
    for (const [source, target] of [["hooks/opencode/termbeacon.js", "opencode/termbeacon.js"], ["hooks/pi/termbeacon.js", "pi/termbeacon.js"], ["hooks/shared/status-reporter.js", "shared/status-reporter.js"], ["scripts/termbeacon-hook.cjs", "termbeacon-hook.cjs"]]) {
      if (!readFileSync(join(root, source)).equals(readFileSync(join(resourcesDir, "termbeacon-hooks", target)))) errors.push(`packaged hook differs from source: ${source}`);
    }

  } catch (error) {
    errors.push(`inspect packaged runtime: ${error.message}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[verify:dist] error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[verify:dist] ready: TermBeacon-${version}-setup.exe`);
}
