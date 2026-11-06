/**
 * Installs the TermBeacon opencode plugin so agent state reaches the app.
 *
 *   node scripts/hooks-install.cjs                 # global: ~/.config/opencode/plugin
 *   node scripts/hooks-install.cjs --project       # ./.opencode/plugin
 *   node scripts/hooks-install.cjs --print-claude       # print a ready-to-paste snippet
 *   node scripts/hooks-install.cjs --configure-claude   # merge Claude settings with a backup
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

// Claude Code reads hooks from settings.json. The default command remains
// non-destructive; --configure-claude opts into an atomic, backed-up merge.
function claudeSnippet({ root = repoRoot } = {}) {
  const example = fs.readFileSync(claudeExample, "utf8");
  const command = `${root.replace(/\\/g, "/")}/scripts/termbeacon-hook.cjs`;
  return example.replace(/C:\/path\/to\/TermBeacon\/scripts\/termbeacon-hook\.cjs/g, command);
}

function claudeSettingsPath({ home = os.homedir(), project = false, cwd = process.cwd() } = {}) {
  return project
    ? path.join(cwd, ".claude", "settings.json")
    : path.join(home, ".claude", "settings.json");
}

function parseJsonFile(target) {
  if (!fs.existsSync(target)) return {};
  const raw = fs.readFileSync(target, "utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Claude settings must be a JSON object: ${target}`);
  return parsed;
}

function isTermBeaconHook(value) {
  return value && typeof value === "object" && typeof value.command === "string"
    && value.command.toLowerCase().includes("termbeacon-hook.cjs");
}

function mergeClaudeSettings(existing, addition) {
  const merged = { ...existing, hooks: { ...(existing.hooks || {}) } };
  for (const [event, groups] of Object.entries(addition.hooks || {})) {
    const current = Array.isArray(merged.hooks[event]) ? merged.hooks[event].map((group) => ({ ...group, hooks: Array.isArray(group?.hooks) ? [...group.hooks] : [] })) : [];
    const alreadyConfigured = current.some((group) => group.hooks.some(isTermBeaconHook));
    if (!alreadyConfigured) current.push(...groups.map((group) => ({ ...group, hooks: [...group.hooks] })));
    merged.hooks[event] = current;
  }
  return merged;
}

function configureClaude({ target = claudeSettingsPath(), root = repoRoot, backup = true } = {}) {
  const existing = parseJsonFile(target);
  const addition = JSON.parse(claudeSnippet({ root }));
  const merged = mergeClaudeSettings(existing, addition);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let backupPath;
  if (backup && fs.existsSync(target)) {
    backupPath = `${target}.bak-${Date.now()}`;
    fs.copyFileSync(target, backupPath);
  }
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return { target, backupPath, events: Object.keys(addition.hooks || {}).length };
}

function parseArgs(argv) {
  const args = { project: false, printClaude: false, configureClaude: false, home: undefined, settings: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") args.project = true;
    else if (token === "--print-claude") args.printClaude = true;
    else if (token === "--configure-claude") args.configureClaude = true;
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
  const result = installPlugin({ project: args.project, home: args.home });
  console.log(`[hooks-install] opencode plugin ${result.existed ? "updated" : "installed"}: ${result.target}`);
  console.log("[hooks-install] restart opencode so it picks up the plugin, then run: npm run preflight:cli");

  if (args.printClaude) {
    console.log("");
    console.log("[hooks-install] merge this into ~/.claude/settings.json (or .claude/settings.json):");
    console.log(claudeSnippet());
  } else if (!args.configureClaude) {
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
