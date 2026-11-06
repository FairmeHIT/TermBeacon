# TermBeacon CLI 状态桥接

TermBeacon 启动每个终端时，会向 PTY 环境注入三个变量：

```text
TERMBEACON_TERMINAL_ID
TERMBEACON_HOOK_PORT
TERMBEACON_HOOK_TOKEN
```

CLI 的 hook 或插件把状态 POST 到 `http://127.0.0.1:<port>/hook`，请求头带 `x-termbeacon-token`，body 为：

```json
{ "terminalId": "...", "event": "Stop", "status": "completed" }
```

`status` 只接受 `started`、`running`、`waiting`、`completed`、`failed`。桥接只监听回环地址并校验随机 token；在普通终端里手动启动 CLI 时变量不存在，hook 会自动变成无操作。

## opencode

把 `hooks/opencode/termbeacon.js` 复制到下面任一位置，然后重启 opencode：

- 全局：`%USERPROFILE%\.config\opencode\plugin\termbeacon.js`
- 项目：`<项目>\.opencode\plugin\termbeacon.js`

插件订阅 opencode 的 `event` 流，处理 `session.status`（推荐）、`session.idle`（兼容）、`session.error`、`tool.execute.*` 和权限事件。它不修改 opencode 配置，也不依赖额外 npm 包。

## Claude Code

把 `hooks/claude/settings.example.json` 合并到 `~/.claude/settings.json` 或项目的 `.claude/settings.json`，并把命令里的 `C:/path/to/TermBeacon` 换成实际路径。Claude 会把 hook payload 从 stdin 传给脚本，`scripts/termbeacon-hook.cjs` 会根据 `hook_event_name` 映射状态：

- `UserPromptSubmit` / `PreToolUse` / `PostToolUse` → `running`
- `Notification` → `waiting`
- `Stop` / `SubagentStop` → `completed`

Claude Code 的标题信号已经能独立工作，Hook 是更精确的兜底，尤其在权限询问和工具执行阶段。

## Codex

Codex 目前通过 OSC 0 标题的 Braille spinner 识别工作/空闲，不需要 Hook。如果后续版本提供原生事件，可以用同一个 `scripts/termbeacon-hook.cjs` 接入。

## 手动测试

在 TermBeacon 的终端里执行：

```powershell
node scripts/termbeacon-hook.cjs completed Stop
```

状态灯应立即进入“已完成”。如果没有任何反应，检查 `TERMBEACON_HOOK_PORT` 是否存在于该终端的环境变量中。
