/**
 * Installs the TermBeacon opencode plugin so agent state reaches the app.
 *
 *   node scripts/hooks-install.cjs                 # global: ~/.config/opencode/plugin
 *   node scripts/hooks-install.cjs --project       # ./.opencode/plugin
 *   node scripts/hooks-install.cjs --print-claude  # print a ready-to-paste Claude Code snippet
 *
 * The plugin is a no-op outside TermBeacon: it only reports when the PTY
 * environment carries TERMBEACON_HOOK_PORT/TOKEN/TERMINAL_ID.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const pluginSource = path.join(repoRoot, "hooks", "opencode", "termbeacon.js");
const claudeExample = path.join(repoRoot, "hooks", "claude", "settings.example.json");

function resolvePluginTarget({ project = false, home = os.homedir(), cwd = process.cwd() } = {}) {
  return project
    ? path.join(cwd, ".opencode", "plugin", "termbeacon.js")
    : path.join(home, ".config", "opencode", "plugin", "termbeacon.js");
}

function installPlugin({ project = false, home = os.homedir(), cwd = process.cwd() } = {}) {
  const target = resolvePluginTarget({ project, home, cwd });
  const source = fs.readFileSync(pluginSource);
  const existed = fs.existsSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return { target, existed, bytes: source.length };
}

// Claude Code reads hooks from settings.json. Merging into an existing file is
// left to the user on purpose: a bad merge would break their CLI config.
function claudeSnippet({ root = repoRoot } = {}) {
  const example = fs.readFileSync(claudeExample, "utf8");
  const command = `${root.replace(/\\/g, "/")}/scripts/termbeacon-hook.cjs`;
  return example.replace(/C:\/path\/to\/TermBeacon\/scripts\/termbeacon-hook\.cjs/g, command);
}

function parseArgs(argv) {
  const args = { project: false, printClaude: false, home: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") args.project = true;
    else if (token === "--print-claude") args.printClaude = true;
    else if (token === "--home") args.home = argv[++index];
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
  const result = installPlugin({ project: args.project, home: args.home });
  console.log(`[hooks-install] opencode plugin ${result.existed ? "updated" : "installed"}: ${result.target}`);
  console.log("[hooks-install] restart opencode so it picks up the plugin, then run: npm run preflight:cli");

  if (args.printClaude) {
    console.log("");
    console.log("[hooks-install] merge this into ~/.claude/settings.json (or .claude/settings.json):");
    console.log(claudeSnippet());
  } else {
    console.log("[hooks-install] Claude Code needs a manual settings.json merge; run with --print-claude to print it.");
  }
}

if (require.main === module) main();

module.exports = { resolvePluginTarget, installPlugin, claudeSnippet, parseArgs };
