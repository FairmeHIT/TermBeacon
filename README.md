# TermBeacon MVP

后续开发请先阅读 [交接文档](HANDOFF.md)、[推进计划](docs/development-plan-2026-11.md)、[开发推进提示词](docs/continuation-prompt.md)、[开发手册](docs/development-handbook.md) 和 [工程 Spec](docs/termbeacon-engineering-spec.md)。

## 开发

```powershell
npm install
npm run dev
```

## 构建与启动

```powershell
npm run build
npm start
```

## 发布、签名与自动更新

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
git tag v0.1.1
git push origin v0.1.1
npm run dist:publish
```

如果没有签名证书，可以运行 `npm run dist` 生成未签名测试包。设置 `TERMBEACON_FORCE_SIGNING=1` 后，缺少证书会直接使发布构建失败。正式安装包启动后会从 `FairmeHIT/TermBeacon` 的 GitHub Releases 检查更新，下载完成后在界面提示重启安装；开发模式不会检查更新。

macOS 发布还需要 Apple 公证相关环境变量（`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`）以及可用的 Developer ID 证书。

## 录制真实 CLI 样本

```powershell
npm run record:cli -- --cli claude --name claude-task --task "列出当前目录并说明结果"
```

录制时正常操作 CLI；也可以在延迟后自动提交 `--task` 指定的任务。完成后退出即可，原始捕获写入 `captures/`（已 gitignore），脱敏后再转成 `tests/fixtures/agents/` 下的 fixture。

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
npm run preflight:cli    # 检查 CLI 版本、hook 客户端与插件配置
```

opencode / Claude Code 这类全屏 TUI 需要装插件或 Hook 才能得到准确状态；只靠文本启发式时可能一直显示"工作中"。完整配置、验证、排查和新机器清单见 `hooks/README.md`。

MVP 当前包含：

- Electron + React + TypeScript + Vite。
- xterm.js + FitAddon 终端视图。
- node-pty + Windows ConPTY。
- 独立 Electron utility process 运行 `pty-host`。
- MessageChannelMain/MessagePort 高频 PTY 数据面。
- 多终端创建、切换、停止和后台输出保留。
- 工作中、已完成未查看、就绪、等待输入、异常、已停止状态灯。
- 基于 prompt、输入和基础等待输入模式的第一版状态检测。

当前状态检测已抽出 Agent Registry，并提供 opencode、Codex、Claude Code 和 generic CLI 的 JSONL fixture 回放测试。原生 Hook 已提供统一入口，OSC 9;4 已作为辅助评分信号接入；host 侧已用 250 ms 定时器驱动检测器，终端静默后无需后续输出也能完成确认。任务历史会保存到 `state.json.tasks` 并在当前终端的“任务历史”面板显示。Hook/插件的安装、验证与排查见 `hooks/README.md`。


