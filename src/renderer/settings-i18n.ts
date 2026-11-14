export type SettingsLocale = "zh-CN" | "en";
export const SETTINGS_LANGUAGE_KEY = "termbeacon-settings-language";

// Chinese source messages are also the fallback for older host versions. Keep
// translation in the view so existing previews and progress switch immediately.
const english: Record<string, string> = {
  "设置页面": "Settings page",
  "设置分类": "Settings navigation",
  "返回终端": "Back to terminals",
  "设置": "Settings",
  "工作区": "Workspaces",
  "终端": "Terminals",
  "默认工作区": "Default workspace",
  "工作区 {index}": "Workspace {index}",
  "终端 {index}": "Terminal {index}",
  "工作中": "Working",
  "已完成": "Completed",
  "就绪": "Ready",
  "等待输入": "Waiting for input",
  "异常": "Error",
  "已停止": "Stopped",
  "正在恢复": "Recovering",
  "可恢复": "Resumable",
  "无法恢复": "Cannot resume",
  "双击重命名": "Double-click to rename",
  "添加工作区（选择本地文件夹）": "Add workspace (choose a local folder)",
  "删除工作区「{name}」": "Remove workspace \"{name}\"",
  "删除终端「{title}」？正在运行的进程会被停止。": "Remove terminal \"{title}\"? The running process will be stopped.",
  "删除工作区「{name}」及其中的 {count} 个终端？": "Remove workspace \"{name}\" and its {count} terminal(s)?",
  "目录：{path}": "Directory: {path}",
  "删除": "Remove",
  "未设置目录": "No folder set",
  "新建终端": "New terminal",
  "恢复 CLI 会话": "Resume CLI session",
  "恢复": "Resume",
  "删除终端": "Remove terminal",
  "PTY Host 已断开": "PTY host disconnected",
  "重启 PTY Host": "Restart PTY host",
  "正在重启 PTY Host…": "Restarting PTY host…",
  "PTY Host 重启失败": "Could not restart PTY host",
  "该 CLI 不支持会话恢复": "This CLI does not support session resume",
  "恢复命令失败": "Resume command failed",
  "隐藏工作栏": "Hide sidebar",
  "展开工作栏": "Show sidebar",
  "打开设置": "Open settings",
  "切换到浅色主题": "Switch to light theme",
  "切换到深色主题": "Switch to dark theme",
  "拖动调整侧栏宽度": "Drag to resize sidebar",
  "目录": "Directory",
  "终端已停止，点击重启": "Terminal stopped; click to restart",
  "重启终端": "Restart terminal",
  "新版本": "New version",
  "已下载": "Downloaded",
  "新版本 {version} 已准备好。": "Version {version} is ready.",
  "常规": "General",
  "偏好与管理": "Preferences & management",
  "让工作环境保持顺手。": "Make your workspace feel right.",
  "管理编程助手的安装、版本与状态接入。": "Manage coding agents, versions, and status integration.",
  "检测中…": "Scanning…",
  "重新检测": "Scan again",
  "关闭提示": "Dismiss message",
  "语言": "Language",
  "选择设置页面的显示语言，即时生效并自动保存。": "Choose the settings language. Changes apply immediately and are saved automatically.",
  "外观": "Appearance",
  "选择适合当前环境的主题。": "Choose a theme for your workspace.",
  "主题": "Theme",
  "深色": "Dark",
  "浅色": "Light",
  "默认 Shell": "Default shell",
  "命令提示符": "Command Prompt",
  "用于之后新建的终端。": "Used for new terminals.",
  "应用更新": "App updates",
  "版本未知": "Unknown version",
  "检查并获取 TermBeacon 的新版本。": "Check for and download new versions of TermBeacon.",
  "重启并安装": "Restart and install",
  "检查中…": "Checking…",
  "检查更新": "Check for updates",
  "终端后台服务": "Terminal service",
  "升级状态检测组件后，可在任务结束时重启服务。此操作会关闭当前所有终端进程。": "Restart the service after your tasks finish to load updated status detection components. This closes all terminal processes.",
  "重启中…": "Restarting…",
  "重启服务": "Restart service",
  "重启终端服务将关闭所有终端进程，包括正在运行的 Agent。请先完成或保存任务。确定重启？": "Restarting the terminal service closes all terminal processes, including running agents. Finish or save your tasks first. Restart now?",
  "终端服务重启失败，请稍后重试。": "Could not restart the terminal service. Please try again later.",
  "正在检测本机 CLI…": "Scanning local CLIs…",
  "暂未获取到 CLI 信息。": "CLI information is not available yet.",
  "选择 Agent CLI": "Select an agent CLI",
  "正在处理…": "In progress…",
  "未安装": "Not installed",
  "已安装": "Installed",
  "{name} 管理": "Manage {name}",
  "官方文档 ↗": "Official docs ↗",
  "TermBeacon 托管": "Managed by TermBeacon",
  "系统安装": "System installation",
  "未能读取版本": "Could not read version",
  "等待安装": "Ready to install",
  "启动路径": "Executable",
  "尚未发现可执行文件": "No executable found",
  "托管安装包": "Package",
  "标准化安装": "Managed install",
  "启动中…": "Launching…",
  "在新终端启动": "Launch in new terminal",
  "检查并更新": "Check and update",
  "使用托管安装": "Use managed installation",
  "启用托管安装": "Set up managed installation",
  "正在准备操作预览…": "Preparing operation preview…",
  "操作预览": "Operation preview",
  "确认并执行": "Confirm and run",
  "取消": "Cancel",
  "准备中…": "Preparing…",
  "准备中": "Preparing",
  "状态检测": "Status detection",
  "完成检测受限：缺少有效插件时，任务可能一直显示为工作中。": "Completion detection is limited: without a working plugin, tasks may keep showing as running.",
  "修复状态接入": "Repair status integration",
  "配置状态接入": "Set up status integration",
  "安装与环境详情": "Installation and environment",
  "托管目录": "Managed directory",
  "未找到": "Not found",
  "接入配置": "Integration config",
  "托管安装位于当前用户目录。更新或重装验证通过后才切换入口，旧版本保留；现有终端需要重新打开才能使用新的 PATH。": "Managed installations live in your user directory. Updates and reinstalls are verified before switching; the previous version is kept. Reopen existing terminals to use the new PATH.",
  "标准化重装": "Reinstall managed CLI",
  "回退到 {version}": "Roll back to {version}",
  "切回系统安装": "Switch to system installation",
  "操作日志": "Operation logs",
  "本机检测于 {time} · 只使用当前用户权限": "Scanned locally at {time} · Current user permissions only",
  "OpenAI 的终端编程助手": "OpenAI’s terminal coding agent",
  "开放的终端编程助手": "An open terminal coding agent",
  "Anthropic 的终端编程助手": "Anthropic’s terminal coding agent",
  "可扩展的终端编程助手": "An extensible terminal coding agent",
  "终端标题与输出推断；暂未接入原生生命周期事件。": "Inferred from terminal titles and output; native lifecycle events are not connected yet.",
  "OpenCode 2 插件事件；从 TermBeacon 启动时使用独立服务。": "OpenCode 2 plugin events; uses a standalone service when launched from TermBeacon.",
  "原生 Hook：任务开始、权限请求与主任务完成。": "Native hooks for task start, permission requests, and main task completion.",
  "Pi 1 扩展事件；使用 agent_settled 确认最终空闲。": "Pi 1 extension events; agent_settled confirms the agent is fully idle.",
  "推断检测": "Inferred",
  "未配置接入": "Not configured",
  "接入已配置": "Configured",
  "接入待修复": "Needs repair",
  "配置异常": "Configuration error",
  "使用终端标题与输出推断，可能存在延迟或误判。": "Inferred from terminal titles and output; delays or incorrect states are possible.",
  "配置后需重新启动对应 CLI，运行期间通过本机事件桥接更新状态。": "Restart the CLI after configuration. Status updates use a local event bridge while it runs.",
  "配置文件检查通过后，需重新启动对应 CLI。实际事件连接取决于 CLI 版本与运行环境。": "Restart the CLI after its configuration passes validation. Event delivery depends on the CLI version and runtime environment.",
  "标准化安装需要系统 Node.js 与 npm，请安装 Node.js 22.19 或更新的 LTS 版本。": "Managed installation requires system Node.js and npm. Install Node.js 22.19 or a newer LTS release.",
  "在 {path} 创建独立安装，固定版本 {version}。": "Create an isolated installation in {path}, pinned to version {version}.",
  "安装完成并验证版本后切换入口；原托管版本保留。": "Switch the launcher after installation and version verification; keep the previous managed version.",
  "系统已有安装、登录凭据和项目配置保留。": "Keep existing system installations, credentials, and project configuration.",
  "新启动的 CLI 使用托管版本；已运行的会话继续运行。": "New CLI sessions use the managed version; existing sessions keep running.",
  "配置 TermBeacon 状态接入；变更前备份已有配置。": "Set up TermBeacon status integration; back up existing configuration before changes.",
  "安装或修复 TermBeacon 的 Hook / 扩展；变更前备份已有配置。": "Install or repair TermBeacon hooks and extensions; back up existing configuration before changes.",
  "重启对应 CLI 后生效。": "Takes effect after restarting the CLI.",
  "将新启动的 {name} 切换到系统安装。": "Use the system installation for new {name} sessions.",
  "将新启动的 {name} 切换到托管安装。": "Use the managed installation for new {name} sessions.",
  "将新启动的 {name} 切换到上一托管版本 {version}安装。": "Use the previous managed version {version} for new {name} sessions.",
  "已运行的会话继续运行。": "Existing sessions keep running.",
  "更新 CLI": "Update CLI",
  "使用系统安装": "Use system installation",
  "回退版本": "Roll back version",
  "正在安装 {name} {version}…": "Installing {name} {version}…",
  "正在验证新版本…": "Verifying the new version…",
  "正在配置状态接入…": "Setting up status integration…",
  "正在切换 CLI 入口…": "Switching the CLI launcher…",
  "正在修复状态接入…": "Repairing status integration…",
  "操作完成，新启动的 CLI 将使用更新后的配置。": "Done. New CLI sessions will use the updated configuration.",
  "无法查询官方包版本 ({status})": "Could not query the official package version ({status})",
  "官方包元数据无效": "Invalid official package metadata",
  "CLI 管理清单格式无效": "Invalid CLI management manifest",
  "不支持的 Agent CLI": "Unsupported agent CLI",
  "安装包未提供 CLI 入口": "The package does not provide a CLI entry point",
  "安装包 CLI 入口越界": "The CLI entry point is outside the package directory",
  "托管安装已损坏，可执行标准化重装修复。": "The managed installation is damaged. Reinstall the managed CLI to repair it.",
  "托管版本验证失败，请执行标准化重装修复。": "Managed version verification failed. Reinstall the managed CLI to repair it.",
  "不支持的 CLI 操作": "Unsupported CLI operation",
  "该 CLI 正在执行其他操作": "Another operation is running for this CLI",
  "未找到可用的系统安装": "No usable system installation found",
  "未找到可用的托管安装": "No usable managed installation found",
  "没有可回退的托管版本": "No previous managed version is available",
  "先执行标准化安装，再由 TermBeacon 管理更新": "Set up a managed installation before updating through TermBeacon",
  "此 CLI 暂不支持配置原生状态接入": "Native status integration is not available for this CLI yet",
  "当前版本过旧，请先执行标准化安装或更新": "This version is too old. Install or update the managed CLI first",
  "无法读取 Node.js 版本": "Could not read the Node.js version",
  "{name} 需要 Node.js {version} 或更新版本": "{name} requires Node.js {version} or newer",
  "安装路径无法安全创建 Windows 启动入口": "Cannot safely create a Windows launcher at this installation path",
  "操作预览已失效，请重新预览": "The operation preview is no longer valid. Preview it again",
  "安装状态已变化，请重新预览": "The installation state has changed. Preview the operation again",
  "版本验证失败，期望 {expected}，实际 {actual}；当前入口保持原版本。": "Version verification failed: expected {expected}, got {actual}. The current launcher keeps its previous version.",
  "上一版本验证失败，当前入口保持原版本。": "Previous version verification failed. The current launcher keeps its previous version.",
  "托管启动入口缺失，请执行标准化重装修复": "The managed launcher is missing. Reinstall the managed CLI to repair it",
  "未找到可启动的 CLI，请先安装或重新检测": "No launchable CLI found. Install it or scan again",
  "CLI 参数无效": "Invalid CLI arguments",
  "命令执行超时": "Command timed out",
  "命令退出 ({code})": "Command exited ({code})",
  "此 CLI 需要系统 Node.js，请先安装 Node.js": "This CLI requires system Node.js. Install Node.js first",
  "此启动脚本无法安全读取版本；可改用标准化安装": "Cannot safely read the version from this launcher. Use a managed installation",
  "此路径包含 cmd 无法安全引用的字符，请选择 PowerShell": "This path contains characters that cmd cannot safely quote. Select PowerShell",
  "TermBeacon opencode 插件资源不存在": "TermBeacon OpenCode plugin resources are missing",
  "状态接入辅助资源不存在": "Status integration helper resources are missing",
  "TermBeacon Pi 扩展资源不存在": "TermBeacon Pi extension resources are missing",
  "此 CLI 不支持原生状态配置": "This CLI does not support native status configuration",
  "TermBeacon Claude Hook 资源不存在": "TermBeacon Claude hook resources are missing",
  "开发模式（未打包），不检查更新": "Development mode (unpackaged); update checks are unavailable",
  "正在检查更新…": "Checking for updates…",
  "发现新版本 {version}，正在后台下载…": "Version {version} is available. Downloading in the background…",
  "正在下载更新 {percent}%": "Downloading update {percent}%",
  "已是最新版本": "You’re up to date",
  "新版本 {version} 已下载，重启应用即可安装": "Version {version} is downloaded. Restart the app to install",
  "已禁用更新检查（TERMBEACON_DISABLE_UPDATES=1）": "Update checks are disabled (TERMBEACON_DISABLE_UPDATES=1)",
  "当前版本不支持自动更新": "Automatic updates are unavailable in this build",
  "检查失败：{message}": "Update check failed: {message}",
  "未知错误": "Unknown error",
  "连接 GitHub 暂时失败，正在重试（{attempt}/{total}）…": "Could not connect to GitHub. Retrying ({attempt}/{total})…",
  "开发模式（未打包）不检查更新": "Development mode (unpackaged); update checks are unavailable",
  "GitHub 更新服务器响应超时（HTTP {status}），请稍后重试。": "The GitHub update server timed out (HTTP {status}). Please try again later.",
  "GitHub 更新请求过于频繁，请稍后重试。": "Too many GitHub update requests. Please try again later.",
  "GitHub 更新服务器暂时不可用（HTTP {status}），请稍后重试。": "The GitHub update server is temporarily unavailable (HTTP {status}). Please try again later.",
  "未找到更新文件（HTTP 404），请稍后重试或从发布页下载安装包。": "Update files were not found (HTTP 404). Try again later or download the installer from the releases page.",
  "无法获取更新文件（HTTP {status}），请稍后重试。": "Could not fetch update files (HTTP {status}). Please try again later.",
  "连接 GitHub 更新服务器失败，请检查网络后重试。": "Could not connect to the GitHub update server. Check your network and try again.",
  "更新文件校验失败，请稍后重试或从发布页下载安装包。": "Update file verification failed. Try again later or download the installer from the releases page.",
  "无法检查更新，请稍后重试或从发布页下载安装包。": "Could not check for updates. Try again later or download the installer from the releases page.",
};

// Match whole messages only. Paths, commands, and unrecognized third-party
// diagnostics are never rewritten as substrings.
const templates = Object.entries(english).filter(([key]) => key.includes("{")).map(([source, target]) => {
  const names: string[] = [];
  const pattern = source.split(/(\{\w+\})/).map((part) => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return "([\\s\\S]*?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return { pattern: new RegExp(`^${pattern}$`), target, names };
});

function interpolate(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}

export function settingsText(locale: SettingsLocale, source: string, values?: Record<string, string | number>): string {
  if (values) return interpolate(locale === "en" ? english[source] ?? source : source, values);
  if (locale !== "en" || !source) return source;
  if (Object.hasOwn(english, source)) return english[source];
  for (const { pattern, target, names } of templates) {
    const match = pattern.exec(source);
    if (match) return interpolate(target, Object.fromEntries(names.map((name, index) => [name, name === "actual" && match[index + 1] === "未知" ? "unknown" : match[index + 1]])));
  }
  return source;
}

export function readSettingsLocale(storage: Pick<Storage, "getItem">): SettingsLocale {
  try { return storage.getItem(SETTINGS_LANGUAGE_KEY) === "en" ? "en" : "zh-CN"; }
  catch { return "zh-CN"; }
}

export function saveSettingsLocale(storage: Pick<Storage, "setItem">, locale: SettingsLocale) {
  try { storage.setItem(SETTINGS_LANGUAGE_KEY, locale); } catch { /* Session switching still works when storage is unavailable. */ }
}

export function describeSettingsUpdate(locale: SettingsLocale, status: { type: string; version?: string; percent?: number; message?: string } | null, packaged: boolean) {
  const t = (source: string, values?: Record<string, string | number>) => settingsText(locale, source, values);
  if (!packaged) return t("开发模式（未打包），不检查更新");
  if (!status) return "";
  switch (status.type) {
    case "checking": return t(status.message || "正在检查更新…");
    case "available": return t("发现新版本 {version}，正在后台下载…", { version: status.version ?? "" });
    case "downloading": return t("正在下载更新 {percent}%", { percent: Math.round(status.percent || 0) });
    case "not-available": return t("已是最新版本");
    case "downloaded": return t("新版本 {version} 已下载，重启应用即可安装", { version: status.version ?? "" });
    case "disabled": return t("已禁用更新检查（TERMBEACON_DISABLE_UPDATES=1）");
    case "unsupported": return t(status.message ?? "当前版本不支持自动更新");
    case "error": return t("检查失败：{message}", { message: t(status.message ?? "未知错误") });
    default: return "";
  }
}
