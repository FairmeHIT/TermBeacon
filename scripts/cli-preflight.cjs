/**
 * Read-only preflight for real CLI calibration.
 *
 * This intentionally does not install plugins, edit Claude settings, or run a
 * model task. It reports what is ready for the Windows acceptance matrix.
 */
const fs = require("node:fs");
const path = require("node:path");
const { discoverAll } = require("../src/main/cli-discovery.cjs");
const { isTermBeaconHook } = require("../src/main/integration-config.cjs");

function containsTermBeaconHook(value) {
  if (typeof value === "string") return isTermBeaconHook({ command: value });
  if (Array.isArray(value)) return value.some(containsTermBeaconHook);
  if (value && typeof value === "object") return Object.values(value).some(containsTermBeaconHook);
  return false;
}

function inspectPreflight({ discovered, opencodePlugin, claudeSettings, piExtension = false, hookClient }) {
  const installed = Object.values(discovered).filter((item) => item && item.installed);
  const readyForOutputCalibration = installed.length > 0 && Boolean(hookClient);
  const nativeAgents = Object.entries(discovered).filter(([id, item]) => id !== "codex" && item?.installed);
  const configured = { opencode: opencodePlugin, claude: claudeSettings, pi: piExtension };
  return {
    cli: Object.fromEntries(Object.entries(discovered).map(([id, item]) => [id, {
      installed: Boolean(item?.installed),
      version: item?.version,
      executable: item?.executable,
      error: item?.error,
      integration: item?.integration,
      readyForNativeCalibration: Boolean(item?.installed && hookClient && configured[id] && !item.error),
    }])),
    hookClient,
    opencodePlugin,
    claudeSettings,
    piExtension,
    readyForOutputCalibration,
    readyForInteractiveCalibration: readyForOutputCalibration && nativeAgents.length > 0 && nativeAgents.every(([id, item]) => configured[id] && !item.error),
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const discovered = await discoverAll();
  const result = inspectPreflight({
    discovered,
    hookClient: fs.existsSync(path.join(__dirname, "termbeacon-hook.cjs")),
    opencodePlugin: discovered.opencode.integration.state === "configured",
    claudeSettings: discovered.claude.integration.state === "configured",
    piExtension: discovered.pi.integration.state === "configured",
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
    console.log(`- Pi extension: ${result.piExtension ? "configured" : "not configured"}`);
    console.log(`- output calibration: ${result.readyForOutputCalibration ? "ready" : "blocked"}`);
    console.log(`- interactive Hook calibration: ${result.readyForInteractiveCalibration ? "ready" : "blocked"}`);
  }
  if (args.strict && !result.readyForInteractiveCalibration) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(`[preflight] ${error.message}`); process.exitCode = 1; });

module.exports = { containsTermBeaconHook, inspectPreflight, readClaudeSettings };
