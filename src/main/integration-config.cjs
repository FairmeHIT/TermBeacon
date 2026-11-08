const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveAssets({ packaged = false, resourcesPath = process.resourcesPath, appPath = process.cwd(), executablePath = process.execPath } = {}) {
  const root = packaged ? path.join(resourcesPath, "termbeacon-hooks") : path.join(appPath, "hooks");
  return {
    root,
    opencodePlugin: path.join(root, "opencode", "termbeacon.js"),
    piExtension: path.join(root, "pi", "termbeacon.js"),
    statusReporter: path.join(root, "shared", "status-reporter.js"),
    hookScript: packaged ? path.join(root, "termbeacon-hook.cjs") : path.join(appPath, "scripts", "termbeacon-hook.cjs"),
    hookCommand: packaged ? `"${executablePath.replace(/\\/g, "/")}" --hook` : null,
  };
}

function resolvePluginTarget({ home = os.homedir(), env = process.env } = {}) {
  return path.join(env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"), "plugins", "termbeacon", "index.js");
}

function resolveClaudeSettings({ home = os.homedir(), env = process.env } = {}) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json");
}

function installOpencodePlugin({ assets, home = os.homedir(), env = process.env } = {}) {
  if (!assets?.opencodePlugin || !fs.existsSync(assets.opencodePlugin)) throw new Error("TermBeacon opencode 插件资源不存在");
  const target = resolvePluginTarget({ home, env });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = installExtension(assets.opencodePlugin, target, assets);
  return { ...result, migrated: archiveLegacyOpencode(target) };
}

function archiveLegacyOpencode(target) {
  const base = path.dirname(path.dirname(path.dirname(target)));
  const migrated = [];
  for (const legacy of [path.join(base, "plugin", "termbeacon.js"), path.join(base, "plugins", "termbeacon.js")]) {
    if (!fs.existsSync(legacy)) continue;
    const source = fs.readFileSync(legacy, "utf8");
    if (!source.includes("TERMBEACON_HOOK_PORT") || !/\bid\s*:\s*["']termbeacon["']/.test(source)) continue;
    const backup = `${legacy}.bak-${Date.now()}`;
    fs.renameSync(legacy, backup);
    migrated.push(backup);
  }
  return migrated;
}

function installExtension(source, target, assets) {
  const existed = fs.existsSync(target);
  const sourceText = fs.readFileSync(source, "utf8").replaceAll('../shared/status-reporter.js', './status-reporter.js');
  if (sourceText.includes('./status-reporter.js') && (!assets.statusReporter || !fs.existsSync(assets.statusReporter))) throw new Error("状态接入辅助资源不存在");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backupPath = existed ? `${target}.bak-${Date.now()}` : undefined;
  if (backupPath) fs.copyFileSync(target, backupPath);
  for (const [file, contents] of [
    ...(assets.statusReporter ? [[path.join(path.dirname(target), "status-reporter.js"), fs.readFileSync(assets.statusReporter)]] : []),
    [target, sourceText],
  ]) {
    if (file !== target && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try { fs.writeFileSync(temp, contents); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch { /* no temp */ } }
  }
  return { target, existed, backupPath, bytes: fs.statSync(target).size };
}

function resolvePiTarget({ home = os.homedir(), env = process.env } = {}) { return path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "extensions", "termbeacon", "index.js"); }
function configureAgent({ id, assets, home = os.homedir(), env = process.env } = {}) {
  if (id === "claude") return configureClaude({ assets, target: resolveClaudeSettings({ home, env }) });
  if (id === "opencode") return installOpencodePlugin({ assets, home, env });
  if (id === "pi") {
    if (!assets?.piExtension || !fs.existsSync(assets.piExtension)) throw new Error("TermBeacon Pi 扩展资源不存在");
    return installExtension(assets.piExtension, resolvePiTarget({ home, env }), assets);
  }
  throw new Error("此 CLI 不支持原生状态配置");
}

function agentIntegrationStatus({ id, assets, home = os.homedir(), env = process.env } = {}) {
  if (id === "codex") return { state: "inferred", label: "推断检测", detail: "使用终端标题与输出推断，可能存在延迟或误判。" };
  const target = id === "claude" ? resolveClaudeSettings({ home, env }) : id === "pi" ? resolvePiTarget({ home, env }) : resolvePluginTarget({ home, env });
  if (!fs.existsSync(target)) return { state: "missing", label: "未配置接入", path: target, detail: "配置后需重新启动对应 CLI，运行期间通过本机事件桥接更新状态。" };
  try {
    let current;
    if (id === "claude") {
      const settings = parseJsonFile(target);
      const desired = assets?.hookCommand || (assets?.hookScript && hookCommand(assets.hookScript));
      current = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"].every((event) =>
        settings.hooks?.[event]?.some((group) => group.hooks?.some((hook) => isTermBeaconHook(hook) && hook.command === desired)));
    } else {
      const source = id === "pi" ? assets?.piExtension : assets?.opencodePlugin;
      current = Boolean(source && fs.readFileSync(target, "utf8") === fs.readFileSync(source, "utf8").replaceAll('../shared/status-reporter.js', './status-reporter.js')
        && assets.statusReporter && fs.readFileSync(path.join(path.dirname(target), "status-reporter.js"), "utf8") === fs.readFileSync(assets.statusReporter, "utf8"));
    }
    return { state: current ? "configured" : fs.existsSync(target) ? "outdated" : "missing", label: current ? "接入已配置" : fs.existsSync(target) ? "接入待修复" : "未配置接入", path: target,
      detail: "配置文件检查通过后，需重新启动对应 CLI。实际事件连接取决于 CLI 版本与运行环境。" };
  } catch (error) { return { state: "error", label: "配置异常", path: target, detail: error.message }; }
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
  if (!value || typeof value !== "object" || typeof value.command !== "string") return false;
  const command = value.command.toLowerCase();
  return command.includes("termbeacon-hook.cjs") || /(?:^|[\\/"'])termbeacon(?:\.exe)?["']?\s+--hook(?:\s|$)/.test(command);
}

function hookCommand(hookScript) {
  return `node "${hookScript.replace(/\\/g, "/")}"`;
}

function mergeClaudeSettings(existing, hookScript, configuredCommand) {
  const command = configuredCommand || hookCommand(hookScript);
  const addition = { hooks: Object.fromEntries(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"].map((event) => [event, [{ hooks: [{ type: "command", command }] }]])) };
  return mergeClaudeHookGroups(existing, addition);
}

function mergeClaudeHookGroups(existing, addition) {
  const merged = { ...existing, hooks: { ...(existing.hooks || {}) } };
  // Remove only our old child-completion hook; preserve other integrations.
  if (Array.isArray(merged.hooks.SubagentStop)) {
    const remaining = merged.hooks.SubagentStop.map((group) => ({ ...group,
      hooks: Array.isArray(group?.hooks) ? group.hooks.filter((hook) => !isTermBeaconHook(hook)) : [],
    })).filter((group) => group.hooks.length);
    if (remaining.length) merged.hooks.SubagentStop = remaining;
    else delete merged.hooks.SubagentStop;
  }
  for (const [event, groups] of Object.entries(addition.hooks || {})) {
    const current = Array.isArray(merged.hooks[event])
      ? merged.hooks[event].map((group) => ({ ...group, hooks: Array.isArray(group?.hooks) ? group.hooks.filter((hook) => !isTermBeaconHook(hook)) : [] })).filter((group) => group.hooks.length)
      : [];
    current.push(...groups.map((group) => ({ ...group, hooks: [...group.hooks] })));
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

module.exports = { resolveAssets, resolvePluginTarget, resolveClaudeSettings, resolvePiTarget, installOpencodePlugin, mergeClaudeSettings, mergeClaudeHookGroups, isTermBeaconHook, configureClaude, configureAgent, agentIntegrationStatus, installExtension, archiveLegacyOpencode };
