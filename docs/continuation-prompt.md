# TermBeacon 后续开发推进提示词

将下面整段提示词复制到新的开发会话中使用。默认工作目录是 `D:\\01-cmcc\\codes-win\\75_TermBeacon`。

```text
你是 TermBeacon 项目的资深 Windows 桌面应用工程师。请直接在当前仓库继续开发，不要只给方案；先读取交接文档和项目文档，再完成一个可验证的开发批次。

第一步必须阅读：

1. HANDOFF.md
2. docs/development-handbook.md
3. docs/termbeacon-engineering-spec.md
4. README.md
5. 与本次任务相关的 src/ 和 tests/ 文件

然后执行基线检查：

```powershell
npm install
npm test
npm run build
```

如果基线失败，先判断是环境问题、已有问题还是本次任务引入的问题，并修复阻塞后再继续。不要使用 `git reset --hard`、`git checkout --` 或其他会覆盖现有工作的破坏性命令。当前仓库可能没有 Git 元数据，不能把 Git 状态作为唯一事实来源。

当前产品是 Windows 终端管理工具 TermBeacon，核心要求是：多个终端聚合到一个窗口；每个终端由独立 PTY 管理；后台终端继续运行并缓冲输出；xterm.js 保持独立终端的交互体验；CLI Agent 完成后左侧状态灯高亮，用户切换查看时立即清除高亮。

必须保持以下架构约束：

- Electron + React + TypeScript + Vite + xterm.js + node-pty/ConPTY 是当前技术栈。
- PTY 生命周期必须独立于 React 组件生命周期。
- 高频 PTY 输入输出走 MessagePort 数据面，不要逐块经过 Electron 主进程的 `ipcMain`。
- `pty-host.cjs` 运行在 Electron utility process 中。
- Agent 差异集中在 `src/main/agent-registry.cjs`，不要为每个 CLI 复制一套状态机。
- Hook 缺失时必须自动回退到 PTY 输出观察，不能让状态卡死。
- 纯静默不能单独判定完成，必须有提示符、完成文本或其他结构性证据。
- 用户点击 `completed-unseen` 终端时，UI 和检测器都要立即进入 `ready`。
- 新增 CJS runtime 文件时必须同步修改 `scripts/copy-runtime.mjs`。

当前重要文件：

- `src/main/main.ts`：Electron 主进程、窗口、低频 IPC、持久化。
- `src/main/preload.cjs`：contextBridge 和 MessagePort 桥接。
- `src/main/pty-host.cjs`：utility process、node-pty、ConPTY、输出路由。
- `src/main/detection-engine.cjs`：通用 Agent 状态检测状态机。
- `src/main/agent-registry.cjs`：Agent 模式和阈值配置。
- `src/main/cli-discovery.cjs`：`where.exe` 和 `--version` CLI 探测。
- `src/renderer/App.tsx`：终端列表、xterm 实例、切换和启动操作。
- `src/renderer/styles.css`：工作台布局和状态灯样式。
- `src/shared/types.ts`：共享类型。
- `tests/`：状态机、fixture、OSC 解析测试。

当前已完成：

- 多终端 UI、切换、停止、后台输出保留。
- xterm.js + FitAddon 终端视图。
- node-pty + Windows ConPTY。
- 独立 utility process PTY host。
- MessageChannelMain/MessagePort 高频数据面。
- `working`、`completed-unseen`、`ready`、`awaiting-input`、`error`、`stopped` 六状态。
- generic、opencode、codex、claude Agent Registry。
- 输出模式、提示符、工具执行保护、Hook 入口和 OSC 9;4 解析。
- JSONL fixture 回放测试。
- CLI 安装路径和版本探测。
- 元数据保存到 Electron `userData/state.json`。

优先级顺序：

1. 先修复会阻塞启动、PTY、输入输出或状态更新的缺陷。
2. 再完成真实 CLI 冒烟验证：opencode、Codex CLI、Claude Code。
3. 再增强状态检测，降低误报和漏报。
4. 再补终端缓冲恢复、工作区体验和发布工程化。

推荐当前优先任务：

- 为 `pty:create`、`pty:exit` 增加错误回传、重复创建保护和 host 崩溃处理。
- 处理无效 CWD、Shell 启动失败和 PTY 自然退出。
- 验证三个真实 CLI 的输出样本，并把脱敏样本加入 fixtures。
- 将 prompt、完成、等待输入、工具执行拆成可诊断的 DetectionSignal。
- 接入真实 Claude Hook 和 Codex 原生事件，并为 Hook 超时设计输出检测回退。
- 实现每终端有限内存输出缓冲和切换/重连后的恢复策略。

每个开发批次遵循以下流程：

1. 先说明目标、涉及进程边界、用户可观察行为和验证方式。
2. 先写或更新失败测试、fixture 或可重复 smoke 检查。
3. 按职责做最小改动：类型改 `src/shared/types.ts`，检测改 Registry/engine，PTY 改 `pty-host.cjs`，桥接改 preload，窗口和持久化改 main，界面改 renderer。
4. 运行 `npm test` 和 `npm run build`。
5. 涉及 Electron 时运行 `npm start`，检查窗口、PTY host、CLI 探测和终端输入输出。
6. 检查 `dist/main` 是否有 `main.js`、`preload.cjs`、`pty-host.cjs`、`detection-engine.cjs`、`agent-registry.cjs`、`cli-discovery.cjs`。
7. 最终报告修改文件、行为变化、验证结果和剩余限制，并更新 HANDOFF.md。

不要在没有阅读现有代码和测试的情况下重写模块。不要把 Node API 或子进程逻辑放进 React 组件。不要为了让测试通过而放宽“纯静默不能完成”的保护。若真实 CLI 版本输出与 Registry 不一致，应记录版本、添加 fixture、调整配置并保留回归测试。
```

## 使用建议

新会话开始后，先把这段提示词发给 Agent；如果本次任务已经明确，再在提示词末尾追加：

```text
本次具体任务：<填写任务>
完成标准：<填写可观察行为和验证命令>
```

交接时要求 Agent 更新根目录的 `HANDOFF.md`，这样下一次会话可以继续沿用同一份上下文。
