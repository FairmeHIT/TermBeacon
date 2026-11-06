# TermBeacon MVP

后续开发请先阅读 [交接文档](HANDOFF.md)、[推进计划](docs/development-plan-2026-11.md)、[开发推进提示词](docs/continuation-prompt.md)、[开发手册](docs/development-handbook.md) 和 [工程 Spec](docs/termbeacon-engineering-spec.md)。

## 新机器开发

项目可以从干净仓库恢复，不依赖提交 `node_modules` 或本机 Electron 缓存。开发机要求：

- Node.js 20 或更新版本，npm 10 或更新版本。
- Windows 10 22H2 / Windows 11 用于运行 ConPTY 和生成 Windows 安装包；macOS/Linux 可用于代码检查、测试和前端构建。
- Git 和 PowerShell。`opencode`、Codex CLI、Claude Code 是可选集成，未安装时不影响普通终端使用。

首次配置和验证：

```powershell
npm ci
npm run doctor
npm test
npm run build
```

`npm ci` 严格按照 `package-lock.json` 安装依赖；不要把 `node_modules/` 提交到仓库。`npm run doctor` 会检查 Node/npm 版本、锁文件版本和关键依赖。若 `node-pty` 安装脚本在受限环境中失败，应先在 Windows 主机使用 npm 官方缓存完成安装，再重新执行 `npm ci`。

启动开发模式：

```powershell
npm run dev
```

开发模式会启动 Vite 和 Electron 两个进程，窗口使用本地开发服务器；自动更新在未打包模式下不会检查。

## 构建与启动

```powershell
npm run build
npm start
```

生成 Windows 安装包（必须在 Windows 上执行）：

```powershell
npm run dist
```

输出位于 `release/`，安装文件名为 `TermBeacon-<version>-setup.exe`。安装包包含 Electron、React 渲染资源、主进程、`node-pty` 及 Windows ConPTY 原生文件；用户机器不需要安装 Node.js 或 npm，按安装向导完成后即可从开始菜单或桌面快捷方式启动。安装为当前用户安装，不要求管理员权限。

`npm run dist` 会在打包后自动执行 `npm run verify:dist`，检查安装程序、未解包应用、ASAR 内的运行时文件和 `node-pty` 的 win32-x64 原生文件。Windows 上如果遇到本地文件锁，可把已经解压的 Electron 目录通过 `TERMBEACON_ELECTRON_DIST` 指定给 electron-builder；普通新环境不需要设置此变量，构建会使用 electron-builder 的下载缓存。

安装包人工冒烟步骤：安装后启动 TermBeacon，创建一个 PowerShell 终端，执行 `echo TermBeacon-ready`，关闭并再次启动应用，确认窗口和终端列表可恢复，原 PTY 仍可输入。PTY 由独立的无窗口 host 进程持有，关闭 UI 不会停止任务；Windows 系统重启或 host 崩溃后的 CLI session resume 仍需对应 Agent 的恢复适配器。CLI Agent 需要用户另行安装对应 CLI；安装包已经携带 opencode 插件和 Claude Hook，不需要 Node.js。打开设置 →「CLI 集成」即可按需安装或配置，Claude 原有 `settings.json` 会自动备份；Codex 不需要额外 Hook。源码开发环境的手动配置说明见 [`hooks/README.md`](hooks/README.md)。

## 发布、签名与自动更新

> 完整发版流程（提交 → 升版号 → tag → push → 构建 → 上传资产 → 校验）已固化为项目 skill：`.opencode/skills/release/SKILL.md`。在 OpenCode 里说“发布新版本”即可自动加载，或用 `@release` 显式调用；其中 `scripts/create-release.mjs` 也可脱离 OpenCode 单独运行。

窗口大小、位置、最大化状态和侧栏宽度会保存到 Electron `userData/state.json`。每个终端的最近滚动内容会以磁盘快照保存到 `userData/terminal-history/`，单终端上限约 250 KB，低频批量写入，重启后自动恢复。

正式发布使用 GitHub Releases。先设置 `GH_TOKEN`，Windows 代码签名使用 electron-builder 的 `CSC_LINK` 和 `CSC_KEY_PASSWORD` 环境变量，然后运行：

```powershell
$env:GH_TOKEN = "..."
$env:CSC_LINK = "C:\certs\termbeacon.pfx"
$env:CSC_KEY_PASSWORD = "..."
npm run dist:publish
```

发布前必须先推送 tag：GitHub 拒绝为不存在的 tag 创建“已发布”Release，electron-builder 会返回 422 `Published releases must have a valid tag`。

```powershell
git tag vX.Y.Z
git push origin vX.Y.Z
npm run dist:publish
```

如果没有签名证书，可以运行 `npm run dist` 生成未签名测试包。设置 `TERMBEACON_FORCE_SIGNING=1` 后，缺少证书会直接使发布构建失败。正式安装包启动后会从 `FairmeHIT/TermBeacon` 的 GitHub Releases 检查更新，下载完成后在界面提示重启安装；也可以随时点侧栏左下角设置图标 →「更新」→「检查更新」手动检查（显示当前版本、下载进度和失败原因）。开发模式会提示“开发模式（未打包），不检查更新”；设置 `TERMBEACON_DISABLE_UPDATES=1` 可完全禁用。

> 更新检查访问的是 `github.com`（electron-updater 的 GitHub provider 读取 `releases.atom`），不是 `api.github.com`。网络无法直连 `github.com` 时检查会超时，界面会显示失败原因，恢复网络后再点一次「检查更新」即可。

macOS 发布还需要 Apple 公证相关环境变量（`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`）以及可用的 Developer ID 证书。

## 录制真实 CLI 样本

```powershell
npm run record:cli -- --cli claude --name claude-task --task "列出当前目录并说明结果"
```

录制时正常操作 CLI；也可以在延迟后自动提交 `--task` 指定的任务。完成后退出即可，原始捕获写入 `captures/`（已 gitignore），脱敏后再转成 `tests/fixtures/agents/` 下的 fixture。需要同时记录 Hook 时加 `--hook-log`，录制器会启动本地 bridge 并只写入 Hook 的事件名、状态和相对时间。
录制后可先运行 `npm run audit:cli-capture -- --json captures/<file>.jsonl`，它只输出记录数量、字节数、时长、标题信号、退出回执和是否满足 fixture 提炼的结构条件，不输出提示词或终端正文。`fixtureEligible: true` 只表示 capture 结构完整，仍需人工脱敏和状态核对。
人工确认并完成脱敏后，可用 `npm run fixture:from-capture -- --sanitized --input captures/<file>.jsonl --output tests/fixtures/agents/<name>.jsonl --expected completed-unseen` 生成回放 fixture。转换器默认移除环境元数据并把输入替换为 `[task]`，不会把 `exit`/`error` 记录写入 fixture；输出内容仍需人工复核。

开始真实 CLI 验收前，先运行只读预检：

```powershell
npm run preflight:cli
npm run preflight:cli -- --json
```

预检会列出已安装 CLI 版本、Hook 客户端、opencode 插件和 Claude Hook 配置状态。它不会修改用户配置，也不会调用模型；`--strict` 会在插件或 Claude Hook 尚未配置时返回失败，适合验收脚本使用。

## CLI 状态 Hook

`pty-host` 会在本机回环地址启动一个带随机 token 的 hook 桥，并把地址注入每个 PTY 的环境变量。opencode 插件示例在 `hooks/opencode/termbeacon.js`，Claude Code 设置示例在 `hooks/claude/settings.example.json`，安装说明见 `hooks/README.md`。

```powershell
npm run hooks:install    # 安装 opencode 插件，每个环境执行一次
npm run hooks:configure:claude # 幂等合并 Claude Hook，并自动备份已有 settings
npm run preflight:cli    # 检查 CLI 版本、hook 客户端与插件配置
```

opencode / Claude Code 这类全屏 TUI 需要装插件或 Hook 才能得到准确状态；只靠文本启发式时可能一直显示"工作中"。完整配置、验证、排查和新机器清单见 `hooks/README.md`。
`hooks:configure:claude` 只有显式执行时才会写入 Claude 配置；已有文件会先生成带时间戳的 `.bak-*` 备份，重复执行不会重复添加 TermBeacon Hook。

MVP 当前包含：

- Electron + React + TypeScript + Vite。
- xterm.js + FitAddon 终端视图。
- node-pty + Windows ConPTY。
- 独立 Electron host 进程运行 `pty-host`，通过 Named Pipe 与 UI 连接，支持应用重启后重新绑定已有 PTY。
- MessageChannelMain/MessagePort 高频 PTY 数据面。
- 多终端创建、切换、停止和后台输出保留。
- 工作中、已完成未查看、就绪、等待输入、异常、已停止状态灯。
- 基于 prompt、输入和基础等待输入模式的第一版状态检测。

当前状态检测已抽出 Agent Registry，并提供 opencode、Codex、Claude Code 和 generic CLI 的 JSONL fixture 回放测试。原生 Hook 已提供统一入口，OSC 9;4 已作为辅助评分信号接入；host 侧已用 250 ms 定时器驱动检测器，终端静默后无需后续输出也能完成确认。任务历史会保存到 `state.json.tasks` 并在当前终端的“任务历史”面板显示。Hook/插件的安装、验证与排查见 `hooks/README.md`。
当前 fixture 中包含一份从 Windows Claude capture 脱敏派生的标题状态样本；它只用于回归 OSC 标题检测，不等同于完整的真实 CLI 业务验收。


