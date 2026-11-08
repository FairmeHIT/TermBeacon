const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { managedRoot, managedBin, runFile, findCommands, invocation, shellCommand } = require("./cli-runtime.cjs");
const integration = require("./integration-config.cjs");

const CATALOG = {
  codex: { name: "Codex", command: "codex", package: "@openai/codex", docs: "https://developers.openai.com/codex/cli/", description: "OpenAI 的终端编程助手", signal: "终端标题与输出推断；暂未接入原生生命周期事件。" },
  opencode: { name: "OpenCode", command: "opencode", package: "@opencode/cli", docs: "https://opencode.ai/docs", description: "开放的终端编程助手", signal: "OpenCode 2 插件事件；从 TermBeacon 启动时使用独立服务。" },
  claude: { name: "Claude Code", command: "claude", package: "@anthropic-ai/claude-code", docs: "https://code.claude.com/docs/en/setup", description: "Anthropic 的终端编程助手", signal: "原生 Hook：任务开始、权限请求与主任务完成。" },
  pi: { name: "Pi", command: "pi", package: "@earendil-works/pi-coding-agent", docs: "https://github.com/earendil-works/pi", description: "可扩展的终端编程助手", signal: "Pi 1 扩展事件；使用 agent_settled 确认最终空闲。" },
};
const ACTIONS = new Set(["install", "update", "reinstall", "integrate", "use-system", "use-managed", "rollback"]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const versionNumber = (value) => String(value || "").match(/(?:^|[^\d])(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?!\d)/)?.[1];
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomUUID()}`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8"); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
async function registryPackage(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`无法查询官方包版本 (${response.status})`);
  const data = await response.json();
  if (data.name !== name || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(data.version)) throw new Error("官方包元数据无效");
  return data;
}

function createCliManager({ home = os.homedir(), assets, platform = process.platform, env = process.env, run = runFile, find = findCommands, registry = registryPackage, onProgress = () => {} } = {}) {
  const root = managedRoot(home);
  const manifestPath = path.join(root, "manifest.json");
  const plans = new Map();
  const busy = new Map();
  const latest = new Map();
  let scanPending;
  const manifest = async () => {
    const value = await readJson(manifestPath, { version: 1, agents: {} });
    if (value?.version !== 1 || !value.agents || typeof value.agents !== "object" || Array.isArray(value.agents)) throw new Error("CLI 管理清单格式无效");
    return value;
  };
  const checkedId = (id) => { if (!Object.hasOwn(CATALOG, id)) throw new Error("不支持的 Agent CLI"); return CATALOG[id]; };
  async function runtime() {
    const [nodes, npms] = await Promise.all([find("node", { env, home, platform }), find("npm", { env, home, platform })]);
    const node = nodes[0];
    let npm;
    for (const candidate of npms) {
      for (const relative of ["node_modules/npm/bin/npm-cli.js", "../lib/node_modules/npm/bin/npm-cli.js"]) {
        const file = path.resolve(path.dirname(candidate), relative);
        try { await fs.access(file); npm = file; break; } catch { /* next location */ }
      }
      if (npm) break;
    }
    let nodeVersion;
    if (node) nodeVersion = versionNumber(await run(node, ["--version"], { env, timeout: 5000 }).catch(() => ""));
    const ready = Boolean(node && npm && nodeVersion);
    return { node, npm, nodeVersion, ready, message: ready ? "" : node && npm ? "无法读取 Node.js 版本" : "标准化安装需要系统 Node.js 与 npm，请安装 Node.js 22.19 或更新的 LTS 版本。" };
  }
  function safeRelease(record, id) {
    const release = record?.release;
    if (typeof release !== "string" || !/^[\w][\w.-]*$/.test(release)) return null;
    return path.join(root, id, "releases", release);
  }
  async function packageEntry(directory, id) {
    if (!directory) throw new Error("托管安装已损坏，可执行标准化重装修复。");
    const pkgRoot = path.join(directory, platform === "win32" ? "node_modules" : "lib/node_modules", CATALOG[id].package);
    const pkg = await readJson(path.join(pkgRoot, "package.json"), null);
    const relative = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.[CATALOG[id].command];
    if (!relative || typeof relative !== "string") throw new Error("安装包未提供 CLI 入口");
    const entry = path.resolve(pkgRoot, relative);
    if (!entry.startsWith(pkgRoot + path.sep)) throw new Error("安装包 CLI 入口越界");
    await fs.access(entry);
    return { entry, version: pkg.version };
  }
  async function scanAgent(id, state, node) {
    const meta = CATALOG[id];
    const externalPaths = await find(meta.command, { env, home, platform, exclude: [root] });
    const external = externalPaths[0];
    const record = state.agents[id];
    const release = safeRelease(record, id);
    let managed;
    if (release) { try { managed = await packageEntry(release, id); } catch { /* missing/damaged release */ } }
    let executable = record?.source === "managed" ? managed?.entry : external;
    // An invalid managed entry must be visible as broken, not silently launch another install.
    if (!record && !executable) executable = managed?.entry;
    let version;
    let error;
    if (executable) {
      try { const command = await invocation(executable, record?.source === "managed" ? record.node || node : node); const output = await run(command.file, [...command.args, "--version"], { env, timeout: 8000 }); version = versionNumber(output) || output.split(/\r?\n/)[0]?.slice(0, 160); }
      catch (cause) { error = cause.message; }
    } else if (record?.source === "managed") error = "托管安装已损坏，可执行标准化重装修复。";
    return { id, ...meta, installed: Boolean(executable), executable, version, error, source: record?.source === "managed" ? "managed" : external ? "system" : "missing", externalPaths, managedInstalled: Boolean(managed), managedVersion: managed?.version, previousVersion: record?.previous?.version, integration: integration.agentIntegrationStatus({ id, assets, home, env }), operation: busy.get(id) || latest.get(id) };
  }
  async function scan() {
    if (scanPending) return scanPending;
    const pending = scanPending = (async () => {
      const [state, dependencies] = await Promise.all([manifest(), runtime()]);
      const agents = await Promise.all(Object.keys(CATALOG).map((id) => scanAgent(id, state, dependencies.node)));
      return { agents: agents.map((agent) => ({ ...agent, operation: busy.get(agent.id) || latest.get(agent.id) })), runtime: dependencies, root, checkedAt: Date.now() };
    })();
    try { return await pending; } finally { if (scanPending === pending) scanPending = undefined; }
  }
  async function plan({ id, action } = {}) {
    const meta = checkedId(id);
    if (!ACTIONS.has(action)) throw new Error("不支持的 CLI 操作");
    if (busy.has(id)) throw new Error("该 CLI 正在执行其他操作");
    const state = await manifest();
    const dependencies = await runtime();
    const info = await scanAgent(id, state, dependencies.node);
    if (action === "use-system" && !info.externalPaths.length) throw new Error("未找到可用的系统安装");
    if (action === "use-managed" && !info.managedInstalled) throw new Error("未找到可用的托管安装");
    if (action === "rollback") {
      if (!state.agents[id]?.previous) throw new Error("没有可回退的托管版本");
      await packageEntry(safeRelease(state.agents[id].previous, id), id);
    }
    if (action === "update" && info.source !== "managed") throw new Error("先执行标准化安装，再由 TermBeacon 管理更新");
    if (action === "integrate" && (!info.installed || id === "codex")) throw new Error("此 CLI 暂不支持配置原生状态接入");
    if (action === "integrate" && ((id === "opencode" && Number(versionNumber(info.version)?.split(".")[0]) < 2) || (id === "pi" && Number(versionNumber(info.version)?.split(".")[0]) < 1))) throw new Error("当前版本过旧，请先执行标准化安装或更新");
    let packageVersion;
    let command;
    let release;
    const changes = [];
    if (["install", "update", "reinstall"].includes(action)) {
      if (!dependencies.ready) throw new Error(dependencies.message || "无法读取 Node.js 版本");
      const pkg = await registry(meta.package);
      packageVersion = pkg.version;
      if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(packageVersion)) throw new Error("官方包元数据无效");
      release = `${packageVersion}-${randomUUID()}`;
      const min = id === "pi" ? [22, 19] : id === "claude" ? [22, 0] : [20, 0];
      const current = dependencies.nodeVersion.split(".").map(Number);
      if (current[0] < min[0] || current[0] === min[0] && current[1] < min[1]) throw new Error(`${meta.name} 需要 Node.js ${min.join(".")} 或更新版本`);
      command = `npm install --global --prefix "${path.join(root, id, "releases", release)}" --registry https://registry.npmjs.org --no-fund --no-audit ${meta.package}@${packageVersion}${id === "pi" ? " --ignore-scripts" : ""}`;
      changes.push(`在 ${path.join(root, id, "releases")} 创建独立安装，固定版本 ${packageVersion}。`, "安装完成并验证版本后切换入口；原托管版本保留。", "系统已有安装、登录凭据和项目配置保留。", "新启动的 CLI 使用托管版本；已运行的会话继续运行。");
      if (id !== "codex") changes.push("配置 TermBeacon 状态接入；变更前备份已有配置。");
    } else if (action === "integrate") {
      changes.push("安装或修复 TermBeacon 的 Hook / 扩展；变更前备份已有配置。", "重启对应 CLI 后生效。");
    } else changes.push(`将新启动的 ${meta.name} 切换到${action === "rollback" ? `上一托管版本 ${state.agents[id].previous.version}` : action === "use-system" ? "系统" : "托管"}安装。`, "已运行的会话继续运行。");
    const result = { token: randomUUID(), id, action, title: { install: "标准化安装", update: "更新 CLI", reinstall: "标准化重装", integrate: "修复状态接入", "use-system": "使用系统安装", "use-managed": "使用托管安装", rollback: "回退版本" }[action], packageVersion, command, changes, target: release ? path.join(root, id, "releases", release) : path.join(root, id), expiresAt: Date.now() + 5 * 60000 };
    if (plans.size >= 32) plans.delete(plans.keys().next().value);
    plans.set(result.token, { result, release, dependencies, fingerprint: digest(state.agents[id]) });
    return result;
  }
  // Serialize manifest commits across agents without serializing their downloads.
  let writeTail = Promise.resolve();
  function commit(id, record, updateLauncher) {
    const operation = writeTail.catch(() => {}).then(async () => {
      const state = await manifest();
      const target = path.join(managedBin(home), CATALOG[id].command + (platform === "win32" ? ".cmd" : ""));
      const oldLauncher = await fs.readFile(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      try {
        if (updateLauncher) await updateLauncher(target);
        await atomicJson(manifestPath, { ...state, agents: { ...state.agents, [id]: record } });
      } catch (error) {
        if (updateLauncher) {
          if (oldLauncher) { const temp = `${target}.rollback-${randomUUID()}`; await fs.writeFile(temp, oldLauncher, { mode: 0o755 }); await fs.rename(temp, target); }
          else await fs.unlink(target).catch(() => {});
        }
        throw error;
      }
    });
    writeTail = operation;
    return operation;
  }
  async function writeLauncher(id, entry, node) {
    const native = /\.(exe|com)$/i.test(entry) || !/\.[cm]?js$/i.test(entry);
    const values = native ? [entry] : [node, entry];
    let content;
    const target = path.join(managedBin(home), CATALOG[id].command + (platform === "win32" ? ".cmd" : ""));
    if (platform === "win32") {
      if (values.some((s) => !s || /[%!"\r\n]/.test(s))) throw new Error("安装路径无法安全创建 Windows 启动入口");
      content = `@echo off\r\nsetlocal\r\nrem TermBeacon managed CLI\r\n${id === "claude" ? 'set "DISABLE_AUTOUPDATER=1"\r\n' : ""}${values.map((s) => `"${s}"`).join(" ")} %*\r\nexit /b %errorlevel%\r\n`;
    } else content = `#!/bin/sh\n# TermBeacon managed CLI\n${id === "claude" ? "export DISABLE_AUTOUPDATER=1\n" : ""}exec ${values.map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(" ")} "$@"\n`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomUUID()}`;
    try { await fs.writeFile(temp, content, { mode: 0o755 }); await fs.rename(temp, target); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function execute({ token } = {}) {
    if (typeof token !== "string" || !plans.has(token)) throw new Error("操作预览已失效，请重新预览");
    const saved = plans.get(token);
    const { id, action, packageVersion } = saved.result;
    if (busy.has(id)) throw new Error("该 CLI 正在执行其他操作");
    plans.delete(token);
    const progress = (phase, message) => { const event = { id, action, phase, message, at: Date.now() }; busy.set(id, event); latest.set(id, event); onProgress(event); };
    busy.set(id, { id, action, phase: "starting", message: "准备中", at: Date.now() });
    try {
      if (Date.now() > saved.result.expiresAt || digest((await manifest()).agents[id]) !== saved.fingerprint) throw new Error("安装状态已变化，请重新预览");
      const before = (await manifest()).agents[id];
      let record = before;
      let integrationResult;
      if (["install", "update", "reinstall"].includes(action)) {
        const release = saved.release;
        const directory = path.join(root, id, "releases", release);
        await fs.mkdir(directory, { recursive: true });
        progress("installing", `正在安装 ${CATALOG[id].name} ${packageVersion}…`);
        await run(saved.dependencies.node, [saved.dependencies.npm, "install", "--global", "--prefix", directory, "--registry", "https://registry.npmjs.org", "--no-fund", "--no-audit", ...(id === "pi" ? ["--ignore-scripts"] : []), `${CATALOG[id].package}@${packageVersion}`], { env, timeout: 10 * 60000, onOutput: (chunk) => progress("installing", chunk.replace(/\x1b\[[0-9;]*m/g, "").trim()) });
        const installed = await packageEntry(directory, id);
        progress("verifying", "正在验证新版本…");
        const cmd = /\.[cm]?js$/i.test(installed.entry) ? { file: saved.dependencies.node, args: [installed.entry] } : { file: installed.entry, args: [] };
        const detectedVersion = versionNumber(await run(cmd.file, [...cmd.args, "--version"], { env, timeout: 15000 }));
        if (detectedVersion !== packageVersion) throw new Error(`版本验证失败，期望 ${packageVersion}，实际 ${detectedVersion || "未知"}；当前入口保持原版本。`);
        if (id !== "codex") { progress("integrating", "正在配置状态接入…"); integrationResult = integration.configureAgent({ id, assets, home, env }); }
        progress("activating", "正在切换 CLI 入口…");
        record = { source: "managed", release, version: packageVersion, node: saved.dependencies.node, updatedAt: Date.now(), ...(before?.release ? { previous: { release: before.release, version: before.version, node: before.node } } : {}) };
        await commit(id, record, () => writeLauncher(id, installed.entry, saved.dependencies.node));
      } else if (action === "integrate") {
        progress("integrating", "正在修复状态接入…");
        integrationResult = integration.configureAgent({ id, assets, home, env });
      } else if (action === "use-managed") {
        const installed = await packageEntry(safeRelease(before, id), id);
        const node = before.node || saved.dependencies.node;
        const command = await invocation(installed.entry, node);
        if (versionNumber(await run(command.file, [...command.args, "--version"], { env, timeout: 15000 })) !== before.version) throw new Error("托管版本验证失败，请执行标准化重装修复。");
        await commit(id, { ...before, source: "managed", node, updatedAt: Date.now() }, () => writeLauncher(id, installed.entry, node));
      } else if (action === "rollback") {
        const previous = before.previous;
        const installed = await packageEntry(safeRelease(previous, id), id);
        const node = previous.node || saved.dependencies.node;
        const command = await invocation(installed.entry, node);
        if (versionNumber(await run(command.file, [...command.args, "--version"], { env, timeout: 15000 })) !== previous.version) throw new Error("上一版本验证失败，当前入口保持原版本。");
        await commit(id, { ...previous, source: "managed", updatedAt: Date.now(), previous: { release: before.release, version: before.version, node: before.node } }, () => writeLauncher(id, installed.entry, node));
      } else {
        await commit(id, { ...before, source: "system", updatedAt: Date.now() }, async (launcher) => {
          const content = await fs.readFile(launcher, "utf8").catch(() => "");
          if (content.includes("TermBeacon managed CLI")) await fs.unlink(launcher);
        });
      }
      progress("done", "操作完成，新启动的 CLI 将使用更新后的配置。");
      return { ok: true, id, action, integration: integrationResult };
    } catch (error) { progress("error", error.message); throw error; }
    finally { busy.delete(id); scanPending = undefined; }
  }
  async function launch({ id, shell = "cmd.exe", args } = {}) {
    checkedId(id);
    const state = await manifest();
    const record = state.agents[id];
    let executable;
    if (record?.source === "managed") {
      await packageEntry(safeRelease(record, id), id);
      executable = path.join(managedBin(home), CATALOG[id].command + (platform === "win32" ? ".cmd" : ""));
      try { await fs.access(executable); } catch { throw new Error("托管启动入口缺失，请执行标准化重装修复"); }
    } else executable = (await find(CATALOG[id].command, { env, home, platform, exclude: [root] }))[0];
    if (!executable) throw new Error("未找到可启动的 CLI，请先安装或重新检测");
    const cliArgs = args || (id === "opencode" ? ["--standalone"] : []);
    if (!Array.isArray(cliArgs) || cliArgs.some((arg) => typeof arg !== "string" || /[\r\n\x00]/.test(arg))) throw new Error("CLI 参数无效");
    return { command: shellCommand(executable, cliArgs, shell), executable };
  }
  return { scan, plan, execute, launch };
}

module.exports = { createCliManager, CATALOG, registryPackage, versionNumber };
