/**
 * Installs the TermBeacon opencode plugin so agent state reaches the app.
 *
 *   node scripts/hooks-install.cjs                 # global: ~/.config/opencode/plugins
 *   node scripts/hooks-install.cjs --project       # ./.opencode/plugins
 *   node scripts/hooks-install.cjs --print-claude       # print a ready-to-paste snippet
 *   node scripts/hooks-install.cjs --configure-claude   # merge Claude settings with a backup
 *
 * The plugin is a no-op outside TermBeacon: it only reports when the PTY
 * environment carries TERMBEACON_HOOK_PORT/TOKEN/TERMINAL_ID.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const integration = require("../src/main/integration-config.cjs");
const { mergeClaudeHookGroups: mergeClaudeSettings } = integration;

const repoRoot = path.join(__dirname, "..");
const pluginSource = path.join(repoRoot, "hooks", "opencode", "termbeacon.js");
const assets = integration.resolveAssets({ appPath: repoRoot });

function resolvePluginTarget({ project = false, home = os.homedir(), cwd = process.cwd(), env = process.env } = {}) {
  return project ? path.join(cwd, ".opencode", "plugins", "termbeacon", "index.js") : integration.resolvePluginTarget({ home, env });
}

function installPlugin(options = {}) {
  const target = resolvePluginTarget(options);
  return { ...integration.installExtension(pluginSource, target, assets), migrated: integration.archiveLegacyOpencode(target) };
}

function claudeSnippet({ root = repoRoot } = {}) {
  return JSON.stringify(integration.mergeClaudeSettings({}, path.join(root, "scripts", "termbeacon-hook.cjs")), null, 2);
}

function claudeSettingsPath({ home = os.homedir(), project = false, cwd = process.cwd(), env = process.env } = {}) {
  return project ? path.join(cwd, ".claude", "settings.json") : integration.resolveClaudeSettings({ home, env });
}

function configureClaude({ target = claudeSettingsPath(), root = repoRoot, backup = true } = {}) {
  const result = integration.configureClaude({ assets: integration.resolveAssets({ appPath: root }), target, backup });
  return { ...result, events: Object.keys(JSON.parse(claudeSnippet({ root })).hooks).length };
}

function parseArgs(argv) {
  const args = { project: false, printClaude: false, configureClaude: false, configurePi: false, home: undefined, settings: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") args.project = true;
    else if (token === "--print-claude") args.printClaude = true;
    else if (token === "--configure-claude") args.configureClaude = true;
    else if (token === "--configure-pi") args.configurePi = true;
    else if (token === "--home") args.home = argv[++index];
    else if (token === "--settings") args.settings = argv[++index];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(pluginSource)) {
    console.error(`[hooks-install] plugin source missing: ${pluginSource}`);
    process.exitCode = 1;
    return;
  }
  if (!args.printClaude && !args.configureClaude && !args.configurePi) {
    const result = installPlugin({ project: args.project, home: args.home });
    console.log(`[hooks-install] opencode plugin ${result.existed ? "updated" : "installed"}: ${result.target}`);
    console.log("[hooks-install] restart opencode so it picks up the plugin, then run: npm run preflight:cli");
  }
  if (args.configurePi) {
    const target = args.project ? path.join(process.cwd(), ".pi", "extensions", "termbeacon", "index.js") : integration.resolvePiTarget({ home: args.home });
    const result = integration.installExtension(assets.piExtension, target, assets);
    console.log(`[hooks-install] Pi extension installed: ${result.target}`);
  }

  if (args.printClaude) {
    console.log("");
    console.log("[hooks-install] merge this into ~/.claude/settings.json (or .claude/settings.json):");
    console.log(claudeSnippet());
  } else if (!args.configureClaude && !args.configurePi) {
    console.log("[hooks-install] Claude Code needs a manual settings.json merge; run with --print-claude to print it.");
  }
  if (args.configureClaude) {
    try {
      const target = args.settings || claudeSettingsPath({ home: args.home, project: args.project });
      const configured = configureClaude({ target });
      console.log(`[hooks-install] Claude Hook settings merged: ${configured.target}`);
      if (configured.backupPath) console.log(`[hooks-install] backup: ${configured.backupPath}`);
    } catch (error) {
      console.error(`[hooks-install] Claude settings were not changed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();

module.exports = { resolvePluginTarget, installPlugin, claudeSnippet, claudeSettingsPath, mergeClaudeSettings, configureClaude, parseArgs };
