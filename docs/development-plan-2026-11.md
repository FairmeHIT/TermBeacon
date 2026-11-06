# TermBeacon 下一阶段推进计划

日期：2026-11-05  
依据：`HANDOFF.md`、`docs/termbeacon-engineering-spec.md`、`docs/development-handbook.md` 与当前 `src/`、`tests/` 源码审阅。

## 一、现状判断

TermBeacon 的工程骨架已经完整：Electron + React + TypeScript + Vite、xterm.js、node-pty/ConPTY、独立 utility process 的 `pty-host`、MessagePort 数据面、六状态机、Agent Registry、JSONL fixture、多工作区、持久化、NSIS 打包都已落地。交接记录显示上一轮基线为 45 项测试通过；当前基线为 111 项全部通过，构建通过，并已在本机验证过三个 CLI 的 `--version` 与 `--help` 启动链路。

但从源码看，产品最核心的卖点——“Agent 完成后左侧状态灯高亮”——目前并不可靠。主要问题不是规则细节，而是检测链路缺少运行时驱动，以及输入与证据窗口的处理方式会把大量非任务操作当成任务。这些问题不解决，继续增加 Agent、调模式或做发布，用户看到的仍然是一个不会亮、或者乱亮的灯。

## 二、关键发现

### P0：检测器没有时间驱动，静默后不会完成（批次 A 已修复）

`src/main/detection-engine.cjs` 的 `tick(now)` 负责推进静默窗口和候选确认，但运行时只有两个调用点：`src/main/pty-host.cjs:146` 在每次 PTY 输出后调用，`pty-host.cjs:181` 在每次用户写入后调用。整个仓库没有 `setInterval`、`setTimeout` 或主进程定时器去周期性调用 `tick()`。

后果是：CLI 打印完成提示或提示符后，如果没有后续输出块，确认窗口永远不会被推进，状态停在 `working`。测试之所以全部通过，是因为测试用手动 `tick(4500)` 模拟了时间；真实运行时没有人替它推进时间。这是当前最高优先级缺陷。

### P0：方向键、鼠标和转义序列会被当成任务输入（批次 A 已修复）

`detection-engine.cjs:39-51` 的 `input(data)` 用 `/[^\u0000-\u001f]/` 判断是否可打印字符。方向键是 `ESC [ A`，鼠标 SGR 是 `ESC [ < 0 ; 1 ; 2 M`，其中 `[`、`A`、`M`、数字都是可打印字节。用户在终端里按方向键、滚动或点击鼠标，都会把检测器置为 `armed` 并切到 `working`。这会让“没跑任务却亮工作灯”成为常态。

### P1：证据窗口过宽，旧文本会反复触发状态（批次 A 已修复）

`output()` 把最近 4 KB 文本拼成 `signalText`，等待输入和错误模式在整个 4 KB 上匹配，完成模式也在这个窗口上匹配。只要历史输出里出现过 `Allow`、`permission`、`failed` 或 `Done`，后续任意输出块都会重新命中。错误模式里的裸 `failed`、`Error` 尤其容易把正常构建日志、测试输出判成异常。证据应该是“最近一行或最近一小段”，而不是几 KB 的历史。

### P1：提示符识别覆盖不了真实终端（批次 A 已扩展，仍需真实样本校准）

`agent-registry.cjs:8` 的 prompt 规则只接受整行只有 `>`、`$`、`#`、`❯` 的情况。`cmd.exe` 的 `C:\Users\me>`、PowerShell 的 `PS C:\Users\me>`、Codex CLI 的 `›`、bash 的 `user@host:~$` 都不匹配。generic 终端因此几乎无法通过提示符完成；Codex 也缺少最关键的完成证据。

### P1：启动 Agent 本身会被当成一次任务（批次 A 已修复启动按钮路径）

`App.tsx:351-356` 的启动按钮通过 `pty:write` 写入 `claude`、`codex` 或 `opencode`。`pty-host` 把这个写入交给 `detector.input()`，检测器立即 `armed` 并进入 `working`。CLI 启动后打印 banner 和初始提示符，静默窗口一到就会亮“已完成”。启动动作和任务提交没有区分，这是产品语义上的错误。

### P1：host 崩溃后的终端不可恢复

`main.ts:74-81` 在 host 退出后固定 250 ms 重启，没有退避、没有次数上限；host 持续启动失败时会形成高频重启循环。host 重启后，原 PTY 会话按设计消失，但渲染器里的终端仍是 `error`，没有“重启该终端”的入口，用户只能删除后重建。现有测试没有覆盖这条恢复路径。

### P2：渲染与资源管理问题

`App.tsx:169-171` 在每个 PTY 输出块上调用 `setTerminals`，等于每个输出块触发一次整棵 React 树渲染，没有手册要求的 100–250 ms 节流或批处理。`App.tsx` 没有监听窗口 `resize`，只在切换终端时 `fit()`，改变窗口大小后行列数不会更新。删除终端时没有 `terminal.dispose()`，`terminalViews`、`fitAddons` 和 DOM 节点引用会持续累积。启动时会为所有持久化终端立即创建 PTY，终端多时会出现一次性大量 shell 启动。

### P2：工程与文档卫生

`package.json` 里 `electron-builder` 重复声明了两次（批次 A 已修复），`HANDOFF.md` 前 112 行的乱码和 `README.md` 的过时描述也已重建（批次 A）。`electron-builder.config.cjs` 仍把 Windows 输出目录写死为 `D:/temp-termbeacon-release`，换机器就会失效，留到批次 E 改为可配置项。

## 三、推进顺序

总体顺序是先把灯点亮，再用真实 CLI 校准，然后补稳定性和体验，最后做发布。每一批都必须能独立验收，不允许把“检测规则调整”和“PTY/渲染重构”混在同一批里。

### 批次 A：让状态灯真正可用（已执行）

目标是让一个普通终端和一个真实 CLI 在完成任务后，不依赖后续输出也能在 2–3 秒内点亮，并且非任务输入不会误触发。

工作项包括：在 `pty-host` 增加 250 ms 的检测器 tick 循环，并在 shutdown 时清理；在 `input()` 前剥离 CSI、OSC、SS3 和鼠标序列，只有真正的可打印输入才 `armed`；把等待输入、错误、完成证据限制在最近 1 KB 或末尾几行，避免历史文本反复命中；把提示符识别扩展为 `cmd.exe`、PowerShell、bash、Claude `❯`、Codex `›` 的整行形状；收紧 `waitingInput` 和 `error` 模式，去掉裸 `failed` 这类高误报规则；新增 `launch()` 语义，让“启动 Agent”不再被当成任务；为“静默后无需后续输出即可完成”“方向键不触发 armed”“cmd 提示符完成”“旧 Done 不触发”“启动不亮完成”补回归测试；在 host 协议测试里验证定时器确实周期调用 `tick()`。

验收方式是 `npm test` 与 `npm run build` 通过；手工创建 generic 终端执行一条会静默的命令，静默 2–3 秒后灯变绿；按方向键、滚动、点击终端不会进入工作态；点击已完成终端立即回到就绪；点击“启动 Agent”后停在就绪而不是完成。

完成情况：上述代码与测试已落地，`npm test` 56 项通过，`npm run build` 通过。Windows 侧的 `npm start` 手工验收因本会话运行在 Linux 沙箱尚未执行，已记录在 HANDOFF 6.11。

### 批次 B：真实 CLI 校准与 Hook 接入

目标是用真实事件和真实输出替换猜测。首轮录制已经确认 Claude、Codex、opencode 的 TUI 提示符由 CSI 光标定位和增量重绘绘制，原始 PTY 流末尾通常不是提示符本身，所以不能再把 Registry 正则当作主路径。需要在本机已登录的三个 CLI 上各跑一个最小任务，覆盖启动、提交任务、工具执行、权限询问、完成、`Ctrl+C` 中断六类片段；用 `npm run record:cli -- --cli <agent> --task "<任务>"` 录制，脱敏后按 CLI 版本存入 `tests/fixtures/agents/`。检测路径改为：Claude Code 接 Stop/TaskCompleted Hook，Codex 探测原生状态事件，两者都保留超时和输出检测回退；opencode 先确认是否有 plugin、hook 或 OSC 9;4，没有就评估在 host 侧维护 headless 屏幕缓冲；文本规则只保留给 generic 和行式输出。

验收是三个 CLI 各完成一次真实任务，状态序列可解释；权限询问进入 `awaiting-input`；Hook 关闭或超时后仍能靠回退路径完成；TUI 空闲界面不会误报完成；从启动按钮进入 CLI 后停在就绪，提交任务后才进入工作态。

进展（2026-11-05）：Claude Code 和 Codex 已用真实录制确认 OSC 标题信号并接入检测器，真实任务回放中 Claude 能完成、Codex 能正确进入 `error`；opencode 通过 `hooks/opencode/termbeacon.js` 插件接到 `pty-host` 的本地 hook 桥，`session.status`/`session.idle` 已映射并有用例覆盖。剩余是在 Windows 侧实际安装插件、跑一次真实 opencode 任务确认事件字段，以及给 Claude 接入 `hooks/claude/settings.example.json` 作为标题之外的兜底。

### 批次 C：稳定性与恢复

目标是 host 或视图出问题后用户能恢复，而不是删终端。工作项包括 host 重启的指数退避与次数上限、手动“重启 host”、终端级重建入口、窗口 resize 的 `ResizeObserver` 与 xterm `dispose()`、单实例锁、状态保存前的结构校验，以及 PTY 输出到 React 的批处理与 100–250 ms 节流。验收是手动杀掉 host 后应用能恢复并可重建终端；8 个终端同时输出时界面仍可交互；改变窗口大小后行列数与 PTY 一致。

进展（2026-11-06）：上述后端与渲染器项已落地——`host-restart.cjs` 的指数退避和上限、`pty:restart-host`、单实例锁、`state:save` 清洗、host/终端重启按钮、xterm dispose、resize 监听和输出摘要 100ms 合并；测试 111 项通过。仍需 Windows 侧手工验收 host 崩溃恢复和 8 终端并发输出。

### 批次 D：工作区体验与持久化

目标是让多终端日常使用顺手。工作项包括删除终端/工作区的确认、快捷键与焦点管理、侧栏宽度与窗口尺寸持久化、最近活动时间与摘要持久化、可选的磁盘 scrollback 快照（设上限、低频写入）。验收是重启后布局、激活终端和工作区恢复；误点删除不会直接杀进程。

进展（2026-11-06）：删除确认、`Ctrl+Shift+T/W/↑↓` 快捷键、设置面板说明、窗口 resize 适配、输出摘要 100ms 合并、xterm 释放已完成；侧栏宽度/窗口尺寸持久化和磁盘 scrollback 快照仍未做。

### 批次 E：发布工程化

目标是把当前只能在本机跑的安装包变成可分发版本。工作项包括把 release 输出目录改为可配置项而不是写死 `D:/temp-termbeacon-release`、代码签名、自动更新策略、崩溃日志、在干净 Windows 环境验证安装/升级/卸载。验收是在没有 Node.js 的机器上安装后可启动并创建终端，升级后保留 `state.json`。

## 四、依赖、风险与边界

真实 CLI 校准依赖用户在本机登录并手动跑最小任务；自动化只能覆盖启动、帮助、退出，覆盖不了需要账号的交互任务。TUI 类 CLI（尤其 opencode）的输出不是稳定的行式文本，Registry 规则必须由录制的 fixture 驱动，不能凭猜测扩展。

当前开发环境的 Linux 沙箱无法启动 Windows Electron 或本机 CLI，`npm start` 和 `npm run smoke:cli` 需要在 Windows PowerShell 侧执行；本会话能可靠完成的是 Node 单元测试、TypeScript/Vite 构建和源码级验证。涉及 Electron 的手工验收项会在批次记录里明确标注为“待在 Windows 侧执行”，不会写成已通过。

另一个边界是 PTY 不跨应用重启存活，这是 v1 设计，不是缺陷。批次 C 的“恢复”指 host 崩溃后的重建和渲染器重连，不包含跨进程重启保留原 PTY。
