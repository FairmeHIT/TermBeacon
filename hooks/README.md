# CLI 状态桥接与配置指南

TermBeacon 的"工作中 / 已完成 / 等待输入 / 异常"来自 `pty-host` 里每个终端的检测器。它按下面的可靠性从高到低取信号：

1. **CLI 原生 Hook / 插件**（精确，推荐）：CLI 主动上报 `running` / `waiting` / `completed` / `failed`
2. **OSC 标题**：Codex、Claude Code 用 spinner 字形表示工作、静止标题表示空闲
3. **OSC 9;4 进度**：进度到 100（或 state 0）且静默足够久
4. **文本启发式**：最后一行是 shell 提示符，或最近两行出现 `Done` / `Task complete` / `完成`

全屏 TUI（opencode 等）会持续重绘，第 4 类信号基本失效，所以**只装 opencode 时状态很可能一直停在"工作中"**。装好下面的插件/Hook 就能得到准确状态。

---

## 1. 换环境三步走

```powershell
npm install                 # 或按 README 安装依赖
npm run hooks:install       # 安装 opencode 插件到 ~/.config/opencode/plugin
npm run preflight:cli       # 只读检查：CLI 版本、hook 客户端、插件、Claude 配置
```

`preflight:cli` 的正常输出示例：

```text
TermBeacon CLI preflight
- opencode: installed (opencode v2.2.1)
- codex: installed (codex-cli 0.166.0)
- claude: installed (2.1.318 (Claude Code))
- hook client: ready
- opencode plugin: installed
- Claude Hook settings: not configured
- interactive calibration: ready
```

- `--json`：机器可读（适合脚本）
- `--strict`：任一关键项未配置时返回退出码 1（适合新机器验收 / CI）

装完让 opencode 重新加载插件：`opencode reload`（或重启 opencode）。Claude Code 需要手写一次 settings（见第 3 节）。

---

## 2. opencode 插件

opencode **V2** 的插件 API 与 V1 不兼容：默认导出必须是带 `id` 和 `setup(ctx)` 的定义，V1 的 `event` 钩子已被移除。仓库里的 `hooks/opencode/termbeacon.js` 已按 V2 重写，安装后执行：

```powershell
opencode plugin list
```

应看到 ID 为 `termbeacon` 的行：

```text
ID                  VERSION  SOURCE
termbeacon          local    C:\Users\<you>\.config\opencode\plugin\termbeacon.js
```

ID 显示为 `-` 表示插件加载失败（用 `opencode reload` 重新加载；仍失败时看 `opencode --print-logs` 的输出）。

### 自动安装

```powershell
npm run hooks:install              # 全局：%USERPROFILE%\.config\opencode\plugin\termbeacon.js
npm run hooks:install -- --project # 项目级：<当前目录>\.opencode\plugin\termbeacon.js
```

脚本做三件事：创建目录、把仓库里的 `hooks/opencode/termbeacon.js` 原样写入、打印下一步。重复执行是幂等的（覆盖为最新版本）。

### 手动安装

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugin" | Out-Null
Copy-Item hooks\opencode\termbeacon.js "$env:USERPROFILE\.config\opencode\plugin\termbeacon.js" -Force
```

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/plugin
cp hooks/opencode/termbeacon.js ~/.config/opencode/plugin/termbeacon.js
```

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

同一状态 1 秒内只发一次（去重）。插件不修改 opencode 配置，也不依赖额外 npm 包。

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

插件每次上报都从 `process.env` 读取，因此应用重启、端口或 token 变化都不需要改插件。**在普通终端里手动运行 opencode 时这些变量不存在，插件自动变成空操作**；共享后台 server 模式下插件进程也读不到它们，同样保持沉默，不会报错、不会上报。

---

## 3. Claude Code Hook（推荐）

Claude Code 的标题信号已经能工作，Hook 是更精确的兜底（尤其是权限询问、工具执行阶段的 `waiting` / `running`）。

### 生成可直接粘贴的配置

```powershell
node scripts/hooks-install.cjs --print-claude
```

输出是 `hooks/claude/settings.example.json` 的副本，且已把 `C:/path/to/TermBeacon` 替换成**当前仓库的绝对路径**（正斜杠，Claude 能直接读）。

### 合并方式

先备份，再把 `hooks` 对象合并进 `~/.claude/settings.json`（或项目的 `.claude/settings.json`）：

```powershell
Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak" -ErrorAction SilentlyContinue
```

如果本来没有这个文件，直接把 `--print-claude` 的输出保存为 `settings.json` 即可。合并后 `preflight:cli` 应显示 `Claude Hook settings: configured`（检查方式是递归搜索配置里是否出现 `termbeacon-hook.cjs`）。

### 事件映射

Claude 把 hook payload 从 stdin 传给 `scripts/termbeacon-hook.cjs`，脚本按 `hook_event_name` 映射：

| Claude 事件 | 状态 |
| --- | --- |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | `running` |
| `Notification` | `waiting` |
| `Stop` / `SubagentStop` / `SessionEnd` | `completed` |
| `SessionStart` | `started` |

---

## 4. Codex

不需要 Hook：Codex 在 OSC 0 标题里写 Braille spinner（`⠋⠙⠹…`）表示工作，静止标题表示空闲，检测器已内置规则（2.5s 静默确认，过滤短暂的标题空档）。若后续版本提供原生事件，可以复用 `scripts/termbeacon-hook.cjs`。

---

## 5. 验证是否生效

### 5.1 手动发一次 Hook（最快）

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

### 5.2 真实 opencode

1. 在 TermBeacon 里新建终端，运行 `opencode --standalone`（共享后台 server 读不到终端环境，见第 2 节）
2. 发一条会执行工具的消息
3. 观察侧栏：工作中 →（收到 `session.idle` / `session.execution.succeeded`）已完成

如果状态不动，先确认 `npm run preflight:cli` 里 `opencode plugin: installed`、`opencode plugin list` 中 `termbeacon` 的 ID 不是 `-`，并确认 opencode 是在装插件**之后**重启（或 `opencode reload`）的。

### 5.3 真实 Claude Code

配置好 Hook 后运行 `claude`，提交一次提示：
`UserPromptSubmit` 立刻置"工作中"，`Stop` 置"已完成"；权限弹窗会置"等待输入"。

---

## 6. 故障排查

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
| 项目级插件不生效 | opencode 只加载了一个插件目录或版本差异 | 改用全局路径 `~/.config/opencode/plugin/` 再验证 |

---

## 7. 状态语义与已知局限

| 状态 | 含义 | 进入条件 | 离开方式 |
| --- | --- | --- | --- |
| `working` 工作中 | 正在执行任务 | 用户输入、任意输出、Hook `running` | Hook `completed` 或完成证据 + 静默窗口 |
| `completed-unseen` 已完成 | 任务结束但未查看 | 完成证据 + 静默窗口，或 Hook `completed` | 点击终端 → `ready` |
| `ready` 就绪 | 空闲、已查看 | 初始状态 / 查看完成态 | 下一次输入 |
| `awaiting-input` 等待输入 | 需要用户确认 | 权限/确认文本，或 Hook `waiting` | 用户继续操作 |
| `error` 异常 | 报错 | 错误文本、Hook `failed`、进程异常退出 | 下一次输入（错误态粘滞） |
| `stopped` 已停止 | 进程结束 | 正常退出 | 重启终端 |

静默窗口默认值（`src/main/agent-registry.cjs`）：候选 1.2s、确认 2.5s、工具执行宽限 8s；检测器由 `pty-host` 每 250ms 驱动一次。

**已知局限**：

- 没有 Hook 时，全屏 TUI 的持续重绘会不断刷新"最后输出时间"，静默窗口永远不成立，状态可能卡在"工作中"；
- opencode V2 默认把插件加载到共享后台 server，该进程读不到当前终端的 `TERMBEACON_*`；要用 `opencode --standalone` 才能让插件上报；
- 文本启发式依赖终端画面里出现提示符或 `Done` 类字样，TUI 通常不满足；
- 任务历史（`state.json.tasks`）复用同一套检测结果，所以任务状态与终端状态同步不准。

因此：**换环境时优先把 Hook/插件配好**，其余信号只当兜底。

---

## 8. 协议参考

CLI 侧把状态 POST 到 `http://127.0.0.1:<TERMBEACON_HOOK_PORT>/hook`：

```http
POST /hook
x-termbeacon-token: <TERMBEACON_HOOK_TOKEN>
content-type: application/json

{ "terminalId": "<TERMBEACON_TERMINAL_ID>", "event": "session.idle", "status": "completed" }
```

- `status` 只接受 `started`、`running`、`waiting`、`completed`、`failed`
- 桥接只监听回环地址并校验随机 token；token 每次应用启动重新生成
- 任意语言都可以接入：拿到三个环境变量后发一个 POST 即可，不必使用 Node

`scripts/termbeacon-hook.cjs` 是通用客户端，支持三种用法：

```powershell
node scripts/termbeacon-hook.cjs completed Stop
node scripts/termbeacon-hook.cjs --status completed --event Stop
Get-Content payload.json | node scripts/termbeacon-hook.cjs   # 读取 Claude 的 stdin payload
```

---

## 9. 新机器配置清单

- [ ] 安装 TermBeacon 与 Node（opencode / Claude / Codex 按需）
- [ ] `npm run hooks:install`（或手动复制插件到 `~/.config/opencode/plugin/`）
- [ ] `opencode reload`（或重启 opencode），`opencode plugin list` 中 `termbeacon` 的 ID 不是 `-`
- [ ] 用 `opencode --standalone` 启动（共享后台 server 读不到终端环境）
- [ ] Claude Code：`node scripts/hooks-install.cjs --print-claude`，合并进 `~/.claude/settings.json`
- [ ] `npm run preflight:cli`，确认 `hook client: ready`、目标 CLI 的插件/Hook 为已配置
- [ ] 在 TermBeacon 终端里 `node scripts/termbeacon-hook.cjs completed Stop` 做一次端到端自测
- [ ] （可选）`npm run preflight:cli -- --strict` 作为验收门槛

升级 TermBeacon 后，如果 `hooks/opencode/termbeacon.js` 有变更，重新执行一次 `npm run hooks:install` 即可；插件协议未变时无需任何操作。
