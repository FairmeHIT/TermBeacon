# CLI 状态桥接与配置指南

TermBeacon 的"工作中 / 已完成 / 等待输入 / 异常"来自 `pty-host` 里每个终端的检测器。它按下面的可靠性从高到低取信号：

1. **CLI 原生 Hook / 插件**（优先）：CLI 主动上报 `running` / `waiting` / `completed` / `failed`，当前轮次由原生事件控制，终端重绘和文本不再覆盖它
2. **OSC 标题**：Codex、Claude Code 用 spinner 字形表示工作、静止标题表示空闲
3. **OSC 9;4 进度**：进度到 100（或 state 0）且静默足够久
4. **文本启发式**：最后一行是 shell 提示符，或最近两行出现 `Done` / `Task complete` / `完成`

全屏 TUI（opencode 等）会持续重绘，第 4 类信号基本失效，所以**只装 opencode 时状态很可能一直停在"工作中"**。插件/Hook 能提供明确的状态事件；配置检查通过仍需真实任务验证，不能视为稳定性保证。

---

## 1. 设置页中的 Agent CLI 管理

打开独立的「设置 → Agent CLI」页面，可检测 Codex、OpenCode、Claude Code、Pi 的版本、可执行路径、系统安装与托管安装，并配置状态接入。`Ctrl+,` 打开设置，返回按钮或 Escape 回到终端，现有终端继续运行。后台服务跨应用窗口存活；升级检测组件后，可在任务完成时使用「常规 → 重启服务」加载新代码，此操作会明确确认并关闭当前终端进程。

标准化安装使用官方 npm 包（Codex `@openai/codex`、OpenCode 2 `@opencode/cli`、Claude `@anthropic-ai/claude-code`、Pi `@earendil-works/pi-coding-agent`），安装在当前用户的 `~/.termbeacon/agents/<id>/releases/<version>-<uuid>/`。管理器需要系统 Node.js 与 npm，Pi 至少需要 Node.js 22.19，Claude npm 安装至少需要 Node.js 22。Pi 按官方方案关闭依赖生命周期脚本。

每次操作先显示固定版本、实际安装命令和变更预览。下载和版本检查通过后，才切换 `~/.termbeacon/agents/bin/` 中的入口；新建终端会把这个目录加入 PATH。已有系统安装、凭据和正在运行的会话保留。更新或重装会保留前一托管版本，并支持回退和切回系统安装。Claude 托管入口会关闭后台自动更新，版本由管理器维护。

状态接入和 CLI 安装是不同操作：已安装 CLI 可以单独修复 Hook / 扩展，不必重装。写入前备份配置，检查内容是否为当前版本；“接入已配置”仅表示文件检查通过，仍需重新启动 CLI 并通过真实任务验证。Codex 当前使用标题与输出推断。

源码开发环境也可以运行：

```powershell
npm ci
npm run hooks:install
npm run hooks:configure:claude
npm run preflight:cli
```

`preflight:cli` 是文件与可执行文件检查，不会调用模型。`--json` 输出机器可读结果，`--strict` 检查本机已安装且支持原生事件的 CLI；其中任一接入不匹配或版本探测失败时返回非零退出码。只安装 Codex 时原生事件验收仍未就绪。它与设置页共用探测和配置内容检查，覆盖自定义配置目录及 Pi 扩展。

---

## 2. opencode 插件

opencode **V2** 的插件 API 与 V1 不兼容：默认导出必须是带 `id` 和 `setup(ctx)` 的定义，V1 的 `event` 钩子已被移除。仓库里的 `hooks/opencode/termbeacon.js` 已按 V2 重写，安装后执行：

```powershell
opencode plugin list
```

插件在冷启动时异步激活，单次短暂的 `plugin list --standalone` 可能暂时显示空列表。需要在持续运行的同一服务里等待激活完成，并查看插件状态及日志，不能仅凭文件存在判断成功。

### 安装

```powershell
npm run hooks:install              # 全局：~/.config/opencode/plugins/termbeacon/index.js
npm run hooks:install -- --project # 项目级：<当前目录>/.opencode/plugins/termbeacon/index.js
```

安装器同时复制 `status-reporter.js` 辅助模块，将导入路径调整为包内路径，并备份已有文件。它会归档旧 `plugin/termbeacon.js` 和 `plugins/termbeacon.js` 中明确属于 TermBeacon 的副本，避免重复加载；不识别的文件保留。不要只复制入口文件。

管理器尊重 `OPENCODE_CONFIG_DIR`、`XDG_CONFIG_HOME`、`CLAUDE_CONFIG_DIR` 和 `PI_CODING_AGENT_DIR` 指定的配置目录。

### 它上报什么

插件通过 V2 的 `ctx.event.subscribe()`（公有事件流）和两个钩子（`session.prompt`、`tool.execute.before`）获取状态，映射如下：

| opencode 信号 | TermBeacon 状态 |
| --- | --- |
| `session.prompt` 钩子（提交提示）、`tool.execute.before` 钩子 | `running` → 工作中 |
| `session.status`（busy / retry）、`session.execution.started` | `running` → 工作中 |
| `session.idle`、`session.status`（idle）、`session.execution.succeeded` / `interrupted` | `completed` → 已完成 |
| `session.execution.failed` | `failed` → 异常 |
| `permission.asked` | `waiting` → 等待输入 |
| `permission.replied` | `running` → 工作中 |

同一状态 1 秒内去重，HTTP 按顺序发送。临时失败按 250ms～5s 退避重试，断线期间保留最新状态，队列最多 64 条。事件订阅断开后自动重连；支持 `session.get` / `session.active` 的版本每 5 秒及重连时核对主会话状态，修复漏掉的完成事件。退出插件时取消请求、定时器和重试。

插件绑定当前主会话，忽略子会话和无关会话的完成/失败；当前主会话的直接子会话请求权限时，仍会上报等待输入。插件不修改 opencode 配置，也不依赖额外 npm 包。

> **V2 架构注意（重要）**：opencode V2 默认把插件加载到**后台共享 server**（`opencode service status` 可以看到它的地址）。这个进程的环境变量来自它第一次启动时的客户端，而不是当前终端，所以通常读不到 `TERMBEACON_*`，插件会自动变成空操作——不报错，也不上报。
>
> 想让状态桥接生效，请让 opencode 使用独立 server：
>
> ```powershell
> opencode --standalone            # 交互式 TUI
> opencode run --standalone "..."  # 非交互
> ```
>
> 独立 server 由当前 CLI 进程派生，会继承 TermBeacon 注入的 PTY 环境变量，多个终端之间互不干扰。

### 为什么不需要配置端口

TermBeacon 启动终端时会把下面三个变量注入该 PTY 的环境：

```text
TERMBEACON_TERMINAL_ID
TERMBEACON_HOOK_PORT
TERMBEACON_HOOK_TOKEN
```

插件加载时从 `process.env` 读取连接信息，不需要手写端口或 token。host 重启后需要重新启动 CLI 以继承新的环境变量。**在普通终端里手动运行 opencode 时这些变量不存在，插件自动变成空操作**；共享后台 server 模式下插件进程也读不到它们，同样保持沉默，不会报错、不会上报。

---

## 3. Claude Code Hook（推荐）

Claude Code 配置 Hook 后优先使用原生事件，标题和文本用于没有 Hook 的任务。

### 生成可直接粘贴的配置

```powershell
node scripts/hooks-install.cjs --print-claude
```

输出是 `hooks/claude/settings.example.json` 的副本，且已把 `C:/path/to/TermBeacon` 替换成**当前仓库的绝对路径**（正斜杠，Claude 能直接读）。

### 合并方式

推荐使用配置器显式合并。它保留现有字段和 Hook，写入前为已有文件生成带时间戳的 `.bak-*` 备份，并且重复执行不会重复添加 TermBeacon Hook：

```powershell
npm run hooks:configure:claude
node scripts/hooks-install.cjs --project --configure-claude
node scripts/hooks-install.cjs --configure-claude --settings "C:\path\to\settings.json"
```

默认目标是 `~/.claude/settings.json`；`--project` 使用当前项目的 `.claude/settings.json`，`--settings` 可指定其他文件。`--print-claude` 只打印片段；`--configure-claude` 只配置 Claude，不顺带安装其他插件。无参数的 `hooks:install` 安装 OpenCode 插件。

手工合并时，先备份，再把 `hooks` 对象合并进 `~/.claude/settings.json`（或项目的 `.claude/settings.json`）：

```powershell
Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak" -ErrorAction SilentlyContinue
```

如果本来没有这个文件，直接运行配置器即可；也可以把 `--print-claude` 的输出保存为 `settings.json`。合并后 `preflight:cli` 应显示 `Claude Hook settings: configured`（检查当前七类 Hook 的实际命令是否匹配本版本配置）。

### 事件映射

Claude 把 hook payload 从 stdin 传给 `scripts/termbeacon-hook.cjs`，脚本按 `hook_event_name` 映射：

| Claude 事件 | 状态 |
| --- | --- |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | `running` |
| `PermissionRequest`、需要输入的 `Notification`（permission_prompt / idle_prompt / elicitation_dialog） | `waiting` |
| `Stop` / `SessionEnd` | `completed` |
| `SubagentStop` / `TaskCompleted`、auth_success 等通知、未知事件 | 忽略，不改变主任务状态 |
| `SessionStart` | `started` |

Hook HTTP 最多尝试 3 次，每次超时 800ms，重试间隔 100ms / 250ms。脚本和 EXE 的 `--hook` 共用同一实现。配置器会移除旧的 TermBeacon `SubagentStop` 配置、更新本插件命令路径，并保留其他集成的 Hook。

---

## 4. Codex

当前集成使用 Codex 的 OSC 0/2 标题：Braille spinner（`⠋⠙⠹…`）表示工作，静止标题表示空闲（2.5s 确认窗口）。标题和 OSC 9;4 进度均使用流式解析，支持任意跨块位置、同块多条序列及 BEL / ST 终止符，OSC 内容不会误当作普通完成/报错文本。这仍是依赖 CLI 标题格式的推断，版本升级后需要重新验证。

---

## 5. Pi 扩展

设置页或 `node scripts/hooks-install.cjs --configure-pi` 可以安装或修复 Pi 1 的全局扩展，默认路径为 `~/.pi/agent/extensions/termbeacon/index.js`。`agent_start` 上报工作，`ui_prompt_start/end` 上报等待与继续，`agent_settled` 上报最终完成。`agent_end` 后可能重试或继续队列任务，不作为完成信号。`session_shutdown` 取消 HTTP 与后台重试；普通终端中没有桥接环境变量时保持空操作。

## 6. 验证是否生效

### 6.1 手动发一次 Hook（最快）

在 **TermBeacon 的终端里**执行（先 `cd` 到仓库根目录，或直接用绝对路径）：

```powershell
cd D:\path\to\TermBeacon
node scripts/termbeacon-hook.cjs completed Stop
```

状态灯应立刻变成"已完成"，点击该终端后变回"就绪"。注意这行命令依赖当前目录——在别的目录执行会报 "Cannot find module"，看起来像 Hook 失效，其实是路径没找对。

可以顺带确认环境变量确实注入：

```powershell
echo $env:TERMBEACON_HOOK_PORT
echo $env:TERMBEACON_TERMINAL_ID
```

两者都为空说明这个终端不是 TermBeacon 启动的（或被其他方式重新拉起），Hook 不会工作。

### 6.2 真实 opencode

1. 在 TermBeacon 里新建终端，运行 `opencode --standalone`（共享后台 server 读不到终端环境，见第 2 节）
2. 发一条会执行工具的消息
3. 观察侧栏：工作中 →（收到 `session.idle` / `session.execution.succeeded`）已完成

如果状态不动，先确认 `npm run preflight:cli` 里 `opencode plugin: installed`、`opencode plugin list` 中 `termbeacon` 的 ID 不是 `-`，并确认 opencode 是在装插件**之后**重启（或 `opencode reload`）的。

### 6.3 真实 Claude Code

配置好 Hook 后运行 `claude`，提交一次提示：
`UserPromptSubmit` 立刻置"工作中"，`Stop` 置"已完成"；权限弹窗会置"等待输入"。

---

## 7. 故障排查

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| opencode 一直"工作中" | 插件未安装 / 装完没重新加载 / 用的是共享后台 server | `npm run hooks:install` + `opencode reload`；用 `opencode --standalone` 启动；`opencode plugin list` 确认 ID 不是 `-` |
| opencode 启动时报 `Plugin failed` | 插件仍是 V1 写法，或文件导出有语法错误 | 重新执行 `npm run hooks:install`；`opencode plugin list` 确认 ID 为 `termbeacon`；`opencode --print-logs` 看具体错误 |
| opencode 一直"工作中"但插件已装 | 终端里的 opencode 不是由 TermBeacon 启动（环境变量缺失） | 从 TermBeacon 新建终端再启动 |
| Claude 一直"工作中" | settings 未合并或路径写错 | `--print-claude` 重新生成，确认 `termbeacon-hook.cjs` 路径存在 |
| 手动 `termbeacon-hook.cjs` 无反应且无报错 | 不在 TermBeacon 终端内（脚本静默降级） | 检查两个环境变量 |
| 报 `could not reach the TermBeacon hook bridge` | 应用已退出 / host 正在重启 | 等 host 恢复后重试；token 与端口每次 host 启动重新生成 |
| 状态一变就回"工作中" | 该 CLI 仍在输出（重绘、计时器） | 装 Hook/插件；没有 Hook 的 TUI 只能靠文本启发式，可能不准 |
| "已完成"一直不消失 | 设计如此：未查看状态 | 点击该终端即转为"就绪" |
| 项目级插件不生效 | opencode 只加载了一个插件目录或版本差异 | 改用全局路径 `~/.config/opencode/plugins/termbeacon/` 再验证 |

---

## 8. 状态语义与已知局限

| 状态 | 含义 | 进入条件 | 离开方式 |
| --- | --- | --- | --- |
| `working` 工作中 | 正在执行任务 | 提交输入、Hook `running`；无原生状态时参考输出 | Hook `completed` 或完成证据 + 静默窗口 |
| `completed-unseen` 已完成 | 任务结束但未查看 | 完成证据 + 静默窗口，或 Hook `completed` | 点击终端 → `ready` |
| `ready` 就绪 | 空闲、已查看 | 初始状态 / 查看完成态 | 下一次输入 |
| `awaiting-input` 等待输入 | 需要用户确认 | 权限/确认文本，或 Hook `waiting` | 用户继续操作 |
| `error` 异常 | 报错 | 错误文本、Hook `failed`、进程异常退出 | 下一次输入（错误态粘滞） |
| `stopped` 已停止 | 进程结束 | 正常退出 | 重启终端 |

静默窗口默认值（`src/main/agent-registry.cjs`）：候选 1.2s、确认 2.5s、工具执行宽限 8s；检测器由 `pty-host` 每 250ms 驱动一次。

收到原生事件后，当前轮次保持原生状态，直到另一个原生事件、提交输入、启动 CLI 或进程退出；仅编辑提示词、方向键、后续重绘和静默均不会覆盖状态。原生完成立即清除工具等待标记；重复完成不会重新点亮已查看的任务。带 `eventId` 的重复请求只应用一次，带 `occurredAt` 的旧事件不能覆盖较新的事件或提交输入；未升级客户端仍兼容旧协议。

**已知局限**：

- 没有 Hook 时，全屏 TUI 的持续重绘会不断刷新"最后输出时间"，静默窗口永远不成立，状态可能卡在"工作中"；
- opencode V2 默认把插件加载到共享后台 server，该进程读不到当前终端的 `TERMBEACON_*`；要用 `opencode --standalone` 才能让插件上报；
- 文本启发式依赖终端画面里出现提示符或 `Done` 类字样，TUI 通常不满足；
- 任务历史（`state.json.tasks`）复用同一套检测结果，所以任务状态与终端状态同步不准。

因此：**换环境时优先把 Hook/插件配好**，其余信号只当兜底。

---

## 9. 协议参考

CLI 侧把状态 POST 到 `http://127.0.0.1:<TERMBEACON_HOOK_PORT>/hook`：

```http
POST /hook
x-termbeacon-token: <TERMBEACON_HOOK_TOKEN>
content-type: application/json

{ "terminalId": "<TERMBEACON_TERMINAL_ID>", "event": "session.idle", "status": "completed" }
```

- `status` 只接受 `started`、`running`、`waiting`、`completed`、`failed`
- 可选 `sessionId` 标识会话，`eventId` 标识一次逻辑事件，`occurredAt` 为事件生成时的毫秒时间戳；重试时复用相同 ID 和时间
- 桥接只监听回环地址并校验随机 token；token 每次 PTY host 启动重新生成，关闭或重开 UI 不会重置
- 任意语言都可以接入：拿到三个环境变量后发一个 POST 即可，不必使用 Node

`scripts/termbeacon-hook.cjs` 是通用客户端，支持三种用法：

```powershell
node scripts/termbeacon-hook.cjs completed Stop
node scripts/termbeacon-hook.cjs --status completed --event Stop
Get-Content payload.json | node scripts/termbeacon-hook.cjs   # 读取 Claude 的 stdin payload
```

---

## 10. 新机器配置清单

- [ ] 安装 TermBeacon；OpenCode / Claude / Codex / Pi 按需从设置页托管安装或使用系统安装
- [ ] EXE 用户：打开设置 →「Agent CLI」，按需安装 CLI 和配置状态接入
- [ ] 源码用户：安装 Node.js 后执行 `npm ci`
- [ ] `npm run hooks:install` 安装 OpenCode 插件及共享 reporter
- [ ] `opencode reload`（或重启 opencode），`opencode plugin list` 中 `termbeacon` 的 ID 不是 `-`
- [ ] 用 `opencode --standalone` 启动（共享后台 server 读不到终端环境）
- [ ] Claude Code：`node scripts/hooks-install.cjs --print-claude`，合并进 `~/.claude/settings.json`
- [ ] Pi：设置页配置状态接入，或运行 `node scripts/hooks-install.cjs --configure-pi`
- [ ] `npm run preflight:cli`，确认 `hook client: ready`、目标 CLI 的插件/Hook 为已配置
- [ ] 在 TermBeacon 终端里 `node scripts/termbeacon-hook.cjs completed Stop` 做一次端到端自测
- [ ] （可选）`npm run preflight:cli -- --strict` 作为验收门槛

升级 TermBeacon 后，设置页会按文件内容检查接入是否匹配。若提示需要更新，执行「配置 / 修复状态接入」，并在当前任务结束后重新启动对应 CLI；源码用户也可以运行相应安装脚本。
