/**
 * Read-only preflight for real CLI calibration.
 *
 * This intentionally does not install plugins, edit Claude settings, or run a
 * model task. It reports what is ready for the Windows acceptance matrix.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverAll } = require("../src/main/cli-discovery.cjs");

function containsTermBeaconHook(value) {
  if (typeof value === "string") return value.toLowerCase().includes("termbeacon-hook.cjs");
  if (Array.isArray(value)) return value.some(containsTermBeaconHook);
  if (value && typeof value === "object") return Object.values(value).some(containsTermBeaconHook);
  return false;
}

function inspectPreflight({ discovered, opencodePlugin, claudeSettings, hookClient }) {
  const installed = Object.values(discovered).filter((item) => item && item.installed);
  const readyForOutputCalibration = installed.length > 0 && Boolean(hookClient);
  return {
    cli: Object.fromEntries(Object.entries(discovered).map(([id, item]) => [id, {
      installed: Boolean(item?.installed),
      version: item?.version,
      executable: item?.executable,
    }])),
    hookClient,
    opencodePlugin,
    claudeSettings,
    readyForOutputCalibration,
    readyForInteractiveCalibration: readyForOutputCalibration && Boolean(opencodePlugin && claudeSettings),
  };
}

function readClaudeSettings(settingsPath) {
  try {
    return containsTermBeaconHook(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  return { json: argv.includes("--json"), strict: argv.includes("--strict") };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = os.homedir();
  const opencodePath = path.join(home, ".config", "opencode", "plugin", "termbeacon.js");
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  const result = inspectPreflight({
    discovered: discoverAll(),
    hookClient: fs.existsSync(path.join(__dirname, "termbeacon-hook.cjs")),
    opencodePlugin: fs.existsSync(opencodePath),
    claudeSettings: readClaudeSettings(claudeSettingsPath),
  });
  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log("TermBeacon CLI preflight");
    for (const [id, item] of Object.entries(result.cli)) {
      console.log(`- ${id}: ${item.installed ? `installed${item.version ? ` (${item.version})` : ""}` : "not found"}`);
    }
    console.log(`- hook client: ${result.hookClient ? "ready" : "missing"}`);
    console.log(`- opencode plugin: ${result.opencodePlugin ? "installed" : "not installed"}`);
    console.log(`- Claude Hook settings: ${result.claudeSettings ? "configured" : "not configured"}`);
    console.log(`- output calibration: ${result.readyForOutputCalibration ? "ready" : "blocked"}`);
    console.log(`- interactive Hook calibration: ${result.readyForInteractiveCalibration ? "ready" : "blocked"}`);
  }
  if (args.strict && (!result.readyForInteractiveCalibration || !result.opencodePlugin || !result.claudeSettings)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { containsTermBeaconHook, inspectPreflight, readClaudeSettings };
