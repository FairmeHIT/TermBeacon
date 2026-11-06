const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveAssets({ packaged = false, resourcesPath = process.resourcesPath, appPath = process.cwd(), executablePath = process.execPath } = {}) {
  const root = packaged ? path.join(resourcesPath, "termbeacon-hooks") : path.join(appPath, "hooks");
  return {
    root,
    opencodePlugin: path.join(root, "opencode", "termbeacon.js"),
    hookScript: packaged ? path.join(root, "termbeacon-hook.cjs") : path.join(appPath, "scripts", "termbeacon-hook.cjs"),
    hookCommand: packaged ? `"${executablePath.replace(/\\/g, "/")}" --hook` : null,
  };
}

function resolvePluginTarget({ home = os.homedir() } = {}) {
  return path.join(home, ".config", "opencode", "plugin", "termbeacon.js");
}

function resolveClaudeSettings({ home = os.homedir() } = {}) {
  return path.join(home, ".claude", "settings.json");
}

function installOpencodePlugin({ assets, home = os.homedir() } = {}) {
  if (!assets?.opencodePlugin || !fs.existsSync(assets.opencodePlugin)) throw new Error("TermBeacon opencode 插件资源不存在");
  const target = resolvePluginTarget({ home });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existed = fs.existsSync(target);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(assets.opencodePlugin, temp);
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  return { target, existed, bytes: fs.statSync(target).size };
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

function hookCommand(hookScript) {
  return `node "${hookScript.replace(/\\/g, "/")}"`;
}

function mergeClaudeSettings(existing, hookScript, configuredCommand) {
  const command = configuredCommand || hookCommand(hookScript);
  const addition = Object.fromEntries(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop"].map((event) => [event, [{ hooks: [{ type: "command", command }] }]]));
  const merged = { ...existing, hooks: { ...(existing.hooks || {}) } };
  for (const [event, groups] of Object.entries(addition)) {
    const current = Array.isArray(merged.hooks[event])
      ? merged.hooks[event].map((group) => ({ ...group, hooks: Array.isArray(group?.hooks) ? [...group.hooks] : [] }))
      : [];
    const alreadyConfigured = current.some((group) => group.hooks.some(isTermBeaconHook));
    if (!alreadyConfigured) current.push(...groups.map((group) => ({ ...group, hooks: [...group.hooks] })));
    merged.hooks[event] = current;
  }
  return merged;
}

function configureClaude({ assets, target = resolveClaudeSettings(), backup = true } = {}) {
  if (!assets?.hookScript || !fs.existsSync(assets.hookScript)) throw new Error("TermBeacon Claude Hook 资源不存在");
  const merged = mergeClaudeSettings(parseJsonFile(target), assets.hookScript, assets.hookCommand);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let backupPath;
  if (backup && fs.existsSync(target)) {
    backupPath = `${target}.bak-${Date.now()}`;
    fs.copyFileSync(target, backupPath);
  }
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return { target, backupPath, hookScript: assets.hookScript };
}

function integrationStatus({ assets, home = os.homedir() } = {}) {
  const opencodePluginPath = resolvePluginTarget({ home });
  const claudeSettingsPath = resolveClaudeSettings({ home });
  let claudeHookConfigured = false;
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const settings = parseJsonFile(claudeSettingsPath);
      claudeHookConfigured = Object.values(settings.hooks || {}).some((groups) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isTermBeaconHook)));
    } catch { /* invalid settings are reported when the user tries to configure */ }
  }
  return {
    assetsAvailable: Boolean(assets && fs.existsSync(assets.opencodePlugin) && fs.existsSync(assets.hookScript)),
    opencodePluginInstalled: fs.existsSync(opencodePluginPath),
    claudeHookConfigured,
    opencodePluginPath,
    claudeSettingsPath,
    hookScriptPath: assets?.hookScript || "",
  };
}

module.exports = { resolveAssets, resolvePluginTarget, resolveClaudeSettings, installOpencodePlugin, mergeClaudeSettings, configureClaude, integrationStatus };
