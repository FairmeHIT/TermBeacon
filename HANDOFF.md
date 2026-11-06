# TermBeacon 任务交接文档

更新时间：2026-11-05（Asia/Shanghai）  
项目目录：`D:\01-cmcc\codes-win\75_TermBeacon`  
当前阶段：MVP 核心链路已完成，正在把状态检测从“测试能过”推进到“真实终端可用”，随后做真实 CLI 校准、稳定性恢复和发布工程化。

> 说明：本文件原有的 1–6.1 节因编码错误显示为乱码，已按 `docs/development-handbook.md`、`docs/termbeacon-engineering-spec.md` 和可读的 6.2–6.10 历史记录重建；6.2 起的英文历史记录保持原文。

## 1. 项目目标

TermBeacon 是一个 Windows 终端管理工具，用一个窗口聚合多个本地终端和 CLI Agent。左侧显示工作区和终端列表、状态灯，右侧显示当前 xterm.js 终端。Agent 完成任务后状态灯高亮；用户切换查看时高亮立即清除。

目标 CLI：`opencode`、Codex CLI、Claude Code，以及普通 Shell 的 `generic` 模式。

## 2. 当前完成情况

工程基础已建立：Electron + React + TypeScript + Vite，xterm.js + FitAddon，node-pty + ConPTY，独立 `utilityProcess` 运行 `pty-host.cjs`，`MessageChannelMain` / `MessagePort` 高频数据面，生产构建会把 CJS runtime 复制到 `dist/main`。

终端功能已具备：多终端创建、切换、停止，切换时隐藏 DOM 但保留 PTY 和 xterm 实例，后台输出继续接收，支持输入、ANSI 颜色、滚动、resize、复制粘贴，标题和工作区可重命名。

Agent 与状态检测已具备：`generic`、`opencode`、`codex`、`claude` 四个 Registry；`working`、`completed-unseen`、`ready`、`awaiting-input`、`error`、`stopped` 六状态；输入、PTY 输出、静默窗口、提示符/完成模式、工具执行保护、查看复位、Hook 入口和 OSC 9;4 解析；JSONL fixture 回放测试。

CLI 探测：`src/main/cli-discovery.cjs` 使用 `where.exe` 查找 CLI 并运行 `--version`。上次验证本机版本为 opencode v2.2.1、Codex CLI 0.166.0、Claude Code 2.1.316；版本随环境变化，新会话应重新运行探测，不要把这些版本当作永久固定值。

持久化与发布：工作区、终端、标题、CWD、Agent 类型、激活终端保存到 Electron `userData/state.json`，加载时有结构校验和损坏文件备份；electron-builder 的 Windows NSIS 与 macOS DMG 配置已加入，Windows 安装包已在 `D:/temp-termbeacon-release` 产出并验证可启动。

测试基线：当前 `npm test` 为 111 项全部通过；`npm run build` 通过。由于本会话运行在 Linux 沙箱，构建前临时安装了 Linux 版 Rollup/esbuild 二进制，Windows 侧的 `npm start` 仍需在 PowerShell 中人工验证。

## 3. 关键文件

```text
README.md
HANDOFF.md
docs/development-handbook.md
docs/continuation-prompt.md
docs/termbeacon-engineering-spec.md
docs/development-plan-2026-11.md

src/main/main.ts
src/main/preload.cjs
src/main/pty-host.cjs
src/main/detection-engine.cjs
src/main/agent-registry.cjs
src/main/cli-discovery.cjs
src/main/pty-validation.cjs
src/main/platform.cjs
src/main/state-sanitize.cjs
src/main/cwd-utils.cjs
src/main/title-utils.cjs
src/renderer/App.tsx
src/renderer/styles.css
src/shared/types.ts
scripts/copy-runtime.mjs
scripts/cli-smoke.cjs

tests/detection-engine.test.cjs
tests/fixtures.test.cjs
tests/osc-progress.test.cjs
tests/pty-host-protocol.test.cjs
tests/pty-validation.test.cjs
tests/state-sanitize.test.cjs
tests/cwd-utils.test.cjs
tests/title-utils.test.cjs
tests/fixtures/agents/*.jsonl
```

## 4. 当前已知问题和限制

高优先级：真实 CLI 的交互任务 fixture 仍然没有录制，现有 fixture 是合成的；`opencode` 是 TUI，现有行式提示符规则很可能不适用；启动 Agent 的写入仍会被检测器当成一次任务，启动后可能直接亮“已完成”；`waitingInput` 和 `error` 的规则刚收紧，但还没有真实样本校准。

中优先级：host 崩溃后没有终端级重建入口，固定 250 ms 重启也没有退避和上限；渲染器没有窗口 resize 监听，删除终端不 `dispose()` xterm；每个 PTY 输出块都会 `setState`，没有手册要求的批处理/节流；Hook 只有统一入口，没有真实 Claude/Codex 配置、超时和失效回退；CWD 修改只对下一次 PTY 创建生效。

发布级：release 输出目录在 Windows 上写死为 `D:/temp-termbeacon-release`；没有代码签名、自动更新、崩溃日志和干净 Windows 环境的升级/卸载验证；`node-pty` 原生模块的打包路径虽已用预编译产物验证，但仍需在无 Node.js 的机器上回归。

已知边界：PTY 不跨应用重启存活，这是 v1 设计，不是 bug。host 崩溃会丢失内存输出缓冲和 PTY 会话，replay 只覆盖渲染器端口断开/重连。

## 5. 下一步建议

按 `docs/development-plan-2026-11.md` 执行。顺序是：批次 A 让状态灯真正可用（本批次已实施）；批次 B 用真实 CLI 录制 fixture、校准 Registry、接入 Hook，并区分“启动 Agent”和“提交任务”；批次 C 做 host 恢复、resize、dispose、输出节流；批次 D 做工作区体验和布局持久化；批次 E 做发布工程化。

## 6. 开发约束

开始改动前先读 `docs/development-handbook.md` 和 `docs/termbeacon-engineering-spec.md`。先写 fixture/测试，再改检测规则。不要把 Node API、子进程启动或文件系统操作放进 React 组件；不要让高频 PTY 输出重新经过主进程逐块转发；不要依赖单一 Hook、单一固定文本或纯静默判断完成；不要用破坏性 Git 命令覆盖其他 Agent 的工作；新增 CJS 文件后必须更新 `scripts/copy-runtime.mjs`；修改完成至少运行 `npm test` 和 `npm run build`，涉及 Electron 的改动要在 Windows 侧运行 `npm start` 并检查窗口、PTY host 和输入输出；完成一个批次后更新本文件。

## 6.1 历史批次（2026-11-05 之前）

早期批次完成了工程骨架、xterm.js/FitAddon、node-pty/ConPTY、独立 `pty-host`、MessagePort 数据面、多终端切换与后台输出保留、六状态机、Agent Registry、JSONL fixture、CLI 路径与版本探测、`userData/state.json` 持久化；随后补了 `pty-validation.cjs`、`pty-host` 结构化错误回传、重复创建保护、host 崩溃自动重建、`state:rebuild-detector`、每终端 2 MB 环形输出缓冲与重连 replay、OSC 9;4 评分接入、CWD 目录选择、electron-builder 打包、状态清洗、标题编辑和多工作区支持。详细记录见下方 6.2–6.10。

## 6.2 Detection hardening batch (2026-11-05)

- Extended `src/main/detection-engine.cjs` with a bounded rolling signal tail so completion and prompt markers split across PTY chunks can still be recognized.
- Completion candidates are retained while a tool is marked in flight, but completion is blocked until the configured `maxToolGraceMs` quiet window (8 seconds) has elapsed. This prevents a missing tool-end marker from permanently wedging the detector while preserving the short-term working state.
- OSC 9;4 progress is recorded as auxiliary evidence. Progress 100 by itself does not complete a task; it can only annotate a candidate that also has prompt/completion evidence.
- Added regression coverage for split completion markers, missing tool-end markers, and OSC-only progress.

Validation:

- `npm test`: 21 passed, 0 failed.
- `npm run build`: passed; runtime files copied to `dist/main`.
- `npm start`: Electron launched successfully and was manually stopped after smoke verification.
- Local CLI discovery: opencode v2.2.1, codex-cli 0.166.0, Claude Code 2.1.316.

Next recommended batch: run a real CLI/ConPTY smoke matrix for one short command or prompt per installed CLI, capture sanitized output fixtures, and then adjust only Registry patterns where the recorded output demonstrates a mismatch. Known limitation remains that changing an existing terminal's Agent type does not rebuild its detector; restart or recreate that terminal before changing detector configuration.


## 6.3 Real CLI/ConPTY smoke batch (2026-11-05)

- Added `scripts/cli-smoke.cjs` and the `npm run smoke:cli` command. It launches each installed registered CLI through `cmd.exe` and node-pty/ConPTY, captures a bounded ANSI-stripped version line, verifies natural exit, and exits cleanly after all PTY handles are released.
- Verified the current machine's installed CLIs:
  - `opencode v2.2.1` (exit code 0)
  - `codex-cli 0.166.0` (exit code 0)
  - `2.1.316 (Claude Code)` (exit code 0)
- Updated `src/main/cli-discovery.cjs` to invoke `cmd.exe /d /s /c` with `shell: false`, removing the Node 24 `shell:true` deprecation warning while preserving `.cmd` discovery.

Validation:

- `npm run smoke:cli`: passed for all three installed CLIs.
- `npm test`: 21 passed, 0 failed.
- `npm run build`: passed.

The smoke currently validates CLI discovery, ConPTY startup, output capture, and natural exit. It does not yet exercise an authenticated interactive task, permission prompt, tool call, or provider-specific hook. Those require sanitized task recordings and should be added only after observing a real interactive run.

## 6.4 CLI help and platform smoke follow-up (2026-11-05)

- Extended `npm run smoke:cli` to accept `--help` in addition to the default `--version` check.
- `npm run smoke:cli -- --help` passed for opencode, Codex CLI, and Claude Code; each produced help text through ConPTY and exited with code 0.
- The working tree also contains the platform shell abstraction used by `pty-host`, validation, CLI discovery, renderer defaults, and runtime copying (`src/main/platform.cjs`). It keeps Windows on `cmd.exe`/ConPTY while allowing the smoke and validation paths to run with the host shell on other platforms.

The next useful recording is an authenticated or otherwise safe interactive task. Version and help output are now covered as repeatable launch/exit smoke, but they do not prove provider-specific task completion, permission, tool, or hook signals.

## 6.5 Windows branch: IPC validation and detector rebuild (2026-11-05)

Branch: `win` (Windows-side development line, branched from `main` after the cross-platform batch).

- `src/main/main.ts` now validates the `pty:create` IPC payload with `normalizeCreateRequest` before registering a terminal. Invalid terminal IDs, CWD, dimensions, or agent types are rejected with a structured message instead of silently registering malformed state. This closes the weak main-process message validation flagged in the high-priority list.
- `src/main/pty-host.cjs` adds a `state:rebuild-detector` message: it validates the agent type against `AGENT_TYPES`, requires an existing session, replaces the detector, and emits a `state:update` confirmation. This resolves the known limitation that changing an existing terminal's agent type did not rebuild its detector.
- `src/main/preload.cjs` exposes `rebuildDetector(terminalId, agentType)` over the data port.
- `src/renderer/App.tsx` calls `rebuildDetector` whenever the agent dropdown changes on a live terminal, so the new detection patterns apply immediately without recreating the terminal.
- Added host-protocol tests: detector rebuild success, unknown-terminal rejection (`NOT_FOUND`), and invalid agent rejection (`INVALID_AGENT`).

Validation:

- `npm test`: 23 passed, 0 failed.
- `npm run build`: passed; runtime files copied to `dist/main`.
- `npm start`: launched for production smoke verification.

Remaining from the handoff list: in-memory output buffering with replay on reconnect (high), OSC 9;4 as a scored candidate signal rather than annotation only (medium), CWD directory picker with validation (medium), and packaging via electron-builder/Forge (release).

## 6.6 Windows branch: bounded output buffer and reconnect replay (2026-11-05)

Branch: `win` (follows 6.5).

- `src/main/pty-host.cjs` now maintains a per-terminal bounded ring buffer of PTY output (2 MB cap per terminal, oldest chunks trimmed first). Buffers are created on session create and released on explicit recreate; a natural exit keeps the buffer so a reconnecting renderer can still replay the final tail.
- Added the `pty:replay-request` message: validated `fromSequence` (non-negative integer) plus terminal existence; the host resends every buffered chunk whose sequence exceeds `fromSequence`, each marked `replay: true`.
- `src/main/preload.cjs` tracks the highest consumed output sequence per terminal. On data-port messageerror it records the pending replay needs; when the next `pty:host-ready` arrives it automatically sends `pty:replay-request` for each terminal, then clears the queue. Also exposes `replay()` on the bridge API.
- `src/renderer/App.tsx` deduplicates output by sequence: live duplicates and already-consumed replay chunks are skipped so a reconnect never double-writes into the xterm instance.
- Test harness now captures spawned fake sessions and injects `Buffer` into the vm sandbox; added three protocol tests: partial replay beyond a sequence, full replay from zero, and rejection of unknown terminals / invalid sequences.

Validation:

- `npm test`: 26 passed, 0 failed.
- `npm run build` and `tsc --noEmit`: passed.
- `npm start`: production smoke launched.

Known boundary (unchanged): a host crash clears the in-memory buffers, and PTY sessions do not survive host restart by design; replay covers renderer-side port disconnects and reconnects, not host-level restarts. Remaining next: OSC 9;4 scored signals, CWD picker with validation, workspaces/title persistence polish, and packaging.

## 6.7 Windows branch: OSC 9;4 as a scored signal (2026-11-05)

Branch: `win` (follows 6.6). Closes the medium-priority item "OSC 9;4 目前已解析和测试，但还没有作为候选评分信号完整接入状态决策".

- `parseOscProgress` now accepts the spec-valid form with an omitted progress value (`OSC 9;4;0;` and `OSC 9;4;0`), returning `{ state, progress: undefined }`. Previously these removal sequences failed to parse entirely.
- OSC state 0 (progress line removal) now records `oscCompletedAt` alongside the existing progress-100 rule.
- Scoring rules in `tick()`:
  - **Text evidence dominates**: a prompt/completion candidate with OSC evidence confirms in half the normal window (`confirmMs/2`, floor `candidateMs`) at confidence 0.88 (up from 0.82).
  - **OSC-only path**: when armed but no prompt/completion text ever arrives, progress-100 or state-0 can settle `completed-unseen` at confidence 0.6 via source `osc`, but only after a 3x extended quiet window (`oscOnlyConfirmMs` = 7500ms for the default config) and still bounded by the tool grace window.
  - Unarmed terminals (no user input, no hook) never settle on OSC alone.
- The old invariant "OSC completion progress alone does not complete a task" was deliberately relaxed to "does not complete within the normal quiet window"; the distinction is recorded in the tests.

Validation:

- `npm test`: 32 passed, 0 failed (6 new detector tests + 1 new parser test).
- `npm run build`: passed.
- `npm start`: production smoke launched.

Remaining next: CWD directory picker with validation, real interactive task fixture recording, workspaces/title persistence polish, and packaging via electron-builder/Forge.

## 6.8 Windows branch: CWD picker and electron-builder packaging (2026-11-05)

Branch: `win` (follows 6.7). Two parallel tracks: CWD picker (subagent-assisted) and electron-builder packaging (main agent).

### CWD directory picker

- `src/main/main.ts` adds the `cwd:pick` IPC handler using `dialog.showOpenDialog` with `openDirectory`; returns the chosen absolute path or null on cancel.
- `src/main/preload.cjs` exposes `pickCwd()`.
- `src/renderer/App.tsx`: the workspace-header CWD is now a clickable `cwd-picker` element; a picked path is validated (Windows drive/UNC or Unix absolute, matching the platform constant) before updating the terminal's `cwd`. Semantics documented in the UI: the change applies to the *next* PTY creation for that terminal; live sessions are untouched (v1 boundary).
- New `src/main/cwd-utils.cjs` with `isValidCwd(path, isWindows)` plus `tests/cwd-utils.test.cjs` (4 cases: valid Windows, valid Unix, relative rejected, empty/non-string rejected). Not wired into runtime copy since only tests use it.
- `tsconfig.json` excludes `src/renderer` (Vite owns that build); this fixes a pre-existing tsc conflict between renderer `declare global` blocks and the main-process compilation unit.

### electron-builder packaging

- Added `electron-builder.config.cjs`: NSIS x64 one-click target, `npmRebuild: false` (the packaging machine has no Visual Studio), shipping node-pty's N-API prebuilds via `asarUnpack: node_modules/**`. N-API modules are ABI-stable so the prebuilt ConPTY binaries work under Electron 36.
- `package.json`: `electron` and `electron-builder` moved to devDependencies (builder requirement), added `description`/`author`, new `npm run dist` script (build + electron-builder).
- `release/` added to `.gitignore`. (An earlier experiment used `release-out/`; that directory is build debris left behind by the EBUSY-locked failed runs — delete after reboot.)
- Validated on this machine: `npm run dist` produced `TermBeacon-0.1.0-setup.exe` (91 MB) with `conpty.node` unpacked at the expected path; the packaged app launched with a working window.

### Environment issue discovered (affects builds on this machine)

- The default in-project `release/` output directory hits persistent `EBUSY`/`EPERM` on `win-unpacked.tmp/resources/default_app.asar` during the Electron dist extraction step. Restart Manager reports no locking process; ACL grants do not help; the lock appears to come from a filter driver (Clash TUN / AV) and survives process cleanup. Workaround: the builder output directory is set to `D:/temp-termbeacon-release` (outside the project tree), which builds cleanly. If builds fail with EBUSY again, change `directories.output` to a fresh project-external path.
- `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` is needed in this network environment for the NSIS tool download (GitHub direct times out).

Validation:

- `npm test`: 36 passed, 0 failed.
- `npm run build` and `tsc --noEmit`: passed.
- Packaged exe launched with a working TermBeacon window from the unpacked output.

Remaining next: real interactive task fixture recording (needs an authenticated manual run), workspaces/title persistence polish, code signing + auto-update strategy.

## 6.9 Windows branch: title editing and state sanitization (2026-11-05)

Branch: `win` (follows 6.8). Two parallel tracks: editable terminal titles (subagent-assisted) and persisted-state hardening (main agent).

### Persisted-state hardening

- New `src/main/state-sanitize.cjs`: `sanitizeState(parsed)` performs structural validation of `state.json` at load: non-object/wrong-schema input falls back to the default state; malformed terminals (missing fields, unknown agent types or states) are dropped individually instead of failing the whole load; workspace `terminalIds` referencing unknown terminals are pruned; `activeTerminalId` falls back to the first surviving terminal. Added to the runtime copy list.
- `src/main/main.ts` `readState` now uses the shared sanitizer and, when the file exists but cannot be parsed, preserves the unusable file as `state.json.corrupt-<timestamp>` for inspection instead of letting the next save overwrite it silently (ENOENT remains the normal first-launch path).
- New `tests/state-sanitize.test.cjs`: 4 cases covering fallback, valid passthrough with pruning, malformed-terminal dropping, and active-id fallback.

### Title editing

- Terminal titles are now user-editable: double-click the title in the sidebar list or the workspace header to rename (Enter/blur commits, Escape cancels, trimmed and capped, empty input keeps the old title). The rename flows through the existing debounced saveState, so titles survive restarts.

Validation:

- `npm test`: 40 passed, 0 failed (title-utils and state-sanitize suites included).
- `npm run build` and `tsc --noEmit`: passed; `state-sanitize.cjs` present in `dist/main`.
- `npm start`: production smoke launched with a working window.

Remaining next: real interactive task fixture recording (needs an authenticated manual run), multi-workspace management UI, code signing + auto-update strategy.

## 6.10 Multi-workspace support and macOS packaging target (2026-11-05)

Branch: `main` (win branch merged at this point; both branches point to the same history).

### macOS packaging target

- `electron-builder.config.cjs` adds a `mac` section: dmg target for x64 and arm64, developer-tools category. The builder output directory is now platform-aware: Windows hosts keep the project-external path (filter-driver EBUSY workaround from 6.8); macOS/Linux hosts use the default in-tree `release/`.
- New `npm run dist:mac` script. node-pty's darwin N-API prebuilds make the no-rebuild strategy valid on macOS as well.

### Workspace-aware persisted state

- `PersistedState` (both `src/shared/types.ts` and the main-process interface) gains an optional `activeWorkspaceId`.
- `state-sanitize.cjs` now preserves a valid `activeWorkspaceId` (falling back to the first workspace) and the new test covers both paths.
- Main-process side of the multi-workspace feature; the renderer UI work (workspace tabs, create/switch/rename/delete, per-workspace terminal lists, terminal deletion) was implemented in the same batch and is validated by the full suite below.

Validation:

- `npm test`: 45 passed, 0 failed.
- `tsc --noEmit` (main) and renderer strict type check: passed.
- `npm run build`: passed.

Remaining next: real interactive task fixture recording (needs an authenticated manual run), code signing + auto-update strategy.


## 6.11 检测可用性第一批（2026-11-05，本次）

本批次目标是修复“完成灯不会自己亮”的核心缺陷，并降低非任务输入造成的误报。

- `src/main/pty-host.cjs` 增加 250 ms 的检测器 tick 循环 `startTickLoop()`，在 host 模块加载时启动，`shutdown` 时清理。此前 `tick()` 只在 PTY 输出和用户写入时调用，CLI 静默后确认窗口永远不会推进。
- `src/main/detection-engine.cjs` 增加 `stripInputSequences()`：在判断 `input()` 是否包含可打印字符前，先剥离 CSI、OSC、SS3、鼠标和 bracketed-paste 标记。方向键、鼠标点击/滚动不再把终端置为 `armed` 或 `working`。
- 检测证据窗口从 4 KB 收紧到 1 KB，并新增 `tailLines()`：等待输入最多看末尾 8 行、错误最多看末尾 4 行、完成最多看末尾 2 行；提示符只接受最后一行（或长度不超过 8 的短块）。旧 `Done`、旧 `Allow` 不会在后续每个输出块上反复命中。
- `src/main/agent-registry.cjs` 扩展提示符识别：裸 `>$#❯›%`、PowerShell `PS C:\...>`、cmd `C:\...>`、bash/zsh `user@host:...$`；收紧 `waitingInput`（要求问句/选项/权限菜单结构）和 `error`（要求行首 `Error:`/`Fatal:`、命令不存在、ENOENT 等），去掉裸 `failed` 高误报规则；完成模式排除 `Done in 0.x s` 这类工具耗时行。
- 检测器不再因为 `working` 模式文本单独 `armed`；只有用户可打印输入、工具启动或 Hook 才会激活任务，避免启动 banner 触发假完成。
- 新增 `launch()` 检测入口和 `pty:write` 的 `launch` 标记：启动 Agent 只写入命令，不激活任务；CLI banner 和初始提示符停在 `ready`，用户真正输入任务后才 `armed`。`preload` 暴露 `launch()`，渲染器的“启动 Agent”按钮改用它。
- `tests/pty-host-protocol.test.cjs` 增加 host 定时器驱动测试；`tests/detection-engine.test.cjs` 增加方向键/鼠标不激活、bracketed paste 仍激活、cmd/PowerShell 提示符静默完成、旧 `Done` 不确认、裸 `failed` 不报错、Claude 权限菜单进入 `awaiting-input`、banner 不激活等回归用例。
- 修复 `package.json` 中重复的 `electron-builder` 键；重建 HANDOFF 的乱码前半部分。

验证：

- `npm test`：56 passed, 0 failed。
- `npm run build`：tsc、Vite、runtime copy 全部通过（Linux 沙箱临时安装 Linux 版 Rollup/esbuild 二进制后执行）。
- `npm start`：本会话无法在 Linux 沙箱启动 Windows Electron，待在 Windows PowerShell 侧人工验证；建议重点检查 generic 终端执行静默命令后 2–3 秒变绿、方向键/鼠标不进入工作态、点击已完成终端立即复位。

已知限制：真实 CLI 的交互 fixture 仍未录制；opencode TUI 的提示符识别尚未验证；错误/等待输入模式刚收紧，需要真实样本校准；启动 Agent 的 launch 语义只覆盖“启动按钮”，用户手动输入 CLI 启动命令仍会被当作任务。

## 6.12 CLI 录制工具（2026-11-05）

新增 `scripts/cli-record.cjs` 和 `npm run record:cli`，用于在 Windows 本机录制真实 CLI 的交互输出。它通过 node-pty/ConPTY 启动 CLI，把键盘输入转发给 PTY，同时把每个输出块按相对时间写入 JSONL；正常退出 CLI 后落盘。默认输出到 `captures/`，该目录已加入 `.gitignore`，避免未脱敏内容被提交。

```powershell
cd D:\01-cmcc\codes-win\75_TermBeacon
npm run record:cli -- --cli claude --name claude-basic
npm run record:cli -- --cli codex --name codex-basic
npm run record:cli -- --cli opencode --name opencode-basic
```

录制时正常操作 CLI，完成任务后退出即可。若要覆盖权限询问，请在一个任务里触发工具权限对话框，先让录制保留对话框，再选择允许或拒绝并完成。录制文件可能包含路径、提示词、账号信息或 token，转成 fixture 前必须人工脱敏；不要把原始 capture 直接提交。

验证：已在 Linux 沙箱用 stub PTY + fake CLI 验证输入转发、输出捕获、退出落盘和 JSONL 结构；真实 CLI 录制待 Windows 侧执行。

## 6.13 首轮真实录制回放结论（2026-11-05）

已收到三份 Windows 录制：`claude-claude-basic`、`codex-codex-basic`、`opencode-opencode-basic`。三份都只记录到 CLI 启动和空闲界面，没有真正提交任务；录制器当时还没有过滤鼠标事件，input 记录主要是鼠标/焦点序列。

回放发现两件关键事实。第一，Claude 退出时 cmd 的“终止批处理操作吗(Y/N)?”被旧 `(Y/N)` 规则误判成 `awaiting-input`；已从 `waitingInput` 移除裸 y/n 规则并补回归测试。第二，用 `@xterm/headless` 渲染屏幕后确认：Claude、Codex、opencode 的提示符和状态行是用 CSI 光标定位和增量重绘绘制的，原始 PTY 流末尾通常只有 spinner、ASCII art 或状态栏碎片，不是提示符本身。当前“看最后一行”的文本规则无法可靠识别 TUI 提示符，单靠调 Registry 正则不能让三个 CLI 的灯可靠。

录制器已补：鼠标/焦点/Kitty 键序列不再写入 input 日志（仍会转发给 CLI）；新增 `--task` 和 `--task-delay` 自动提交最小任务，默认 12 秒；纯文本输入和 Enter 才会记录。下一轮录制请带 `--task`，并等任务完成、提示符回来后再退出。

```powershell
npm run record:cli -- --cli claude --name claude-task --task "列出当前目录并说明结果"
npm run record:cli -- --cli codex --name codex-task --task "列出当前目录并说明结果"
npm run record:cli -- --cli opencode --name opencode-task --task "列出当前目录并说明结果"
```

结论：TUI 类 CLI 的主检测路径应优先用原生事件（Claude Stop/TaskCompleted Hook、Codex 能力探测事件），opencode 若没有可用事件，再评估 OSC 9;4 或 host 侧 headless 屏幕缓冲；文本规则只作为 generic 和行式输出的回退。

## 6.14 真实任务回放与 OSC 标题检测（2026-11-05）

收到 Claude 任务/权限、Codex 任务、opencode 任务四份真实录制，自动任务均成功提交。逐字节回放的结果是：旧文本检测在四份录制里都只从 `ready` 进入 `working`，之后再无状态变化；TUI 的提示符和完成文本不在原始 PTY 流末尾，靠 Registry 正则无法完成。

真实信号如下。Claude Code v2.1.318 用 OSC 0 标题表示状态：`◐`/`◑` 是工作中，`✳ Claude Code` 是空闲；任务在 24.034s 回到 `✳`，检测器在 26.75s 点亮 `completed-unseen`，权限录制在 43.784s 回到 `✳`、46.5s 点亮。Codex 0.166.0 用 Braille spinner 前缀表示工作，纯标题表示空闲；中途有约 2.06s 的纯标题空档，2.5s 确认窗成功过滤；真实任务最终因 `Stream disconnected before completion` / `servers are currently overloaded` 进入 `error` 并保持。opencode v2.2.1 没有稳定的标题状态，文本检测仍停在 `working`；它的插件 API 提供 `session.status`（推荐）和已弃用但仍兼容的 `session.idle`，需要走插件桥接。

本批次实现：`detection-engine.cjs` 新增 `parseOscTitle()` 和 `titleWorkingAt`/`titleIdleAt`；Registry 为 claude、codex 增加 title 规则；标题回到空闲后，满足静默窗口和 2.5s 确认窗即进入 `completed-unseen`，`source: "title"`、置信度 0.9；`error` 改为粘性，普通输出不会把它冲回 `working`，只有用户再次输入或 Hook start 才恢复；新增 3 个真实衍生 fixture 和 6 个单元测试；顺带修正 `osc-parser.cjs` 对 `file:///C:/...` 的跨平台解码，使 Windows 录制在 Linux 测试环境也能回放。

验证：`npm test` 86 passed, 0 failed；`npm run build` 通过。剩余工作是 opencode 插件桥接、Claude/Codex Hook 兜底，以及一次真正出现权限对话框的录制；本次 Claude 的 auto mode 自动批准了工具，没有产生权限询问。

## 6.15 CLI Hook 桥接与 opencode 插件（2026-11-05）

新增 `src/main/hook-server.cjs`：在 `pty-host` 内启动只监听 `127.0.0.1` 的 HTTP 桥，随机端口、随机 token，校验 `x-termbeacon-token` 和 `{terminalId,event,status}`，只接受 `started`/`running`/`waiting`/`completed`/`failed`。`pty-host` 启动时创建桥，并在每个 PTY 的环境变量里注入 `TERMBEACON_TERMINAL_ID`、`TERMBEACON_HOOK_PORT`、`TERMBEACON_HOOK_TOKEN`；桥收到事件后直接调用对应 detector 的 `hook()`。创建终端时如果桥还没监听完成，会等一次 `hookReady` 再继续，避免 env 缺端口；shutdown 时关闭桥。

新增 `scripts/termbeacon-hook.cjs` 通用 hook 客户端：从环境变量读取桥地址，支持命令行 `--status/--event`，也支持从 stdin 读取 Claude Code 的 hook payload；映射 `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → `running`，`Notification` → `waiting`，`Stop`/`SubagentStop` → `completed`。不在 TermBeacon 终端里运行时静默退出，不破坏 CLI。

新增 `hooks/opencode/termbeacon.js` 插件示例：订阅 opencode 的 `event` 流，处理 `session.status`（`busy`/`idle`/`error`）、`session.idle`、`session.error`、`tool.execute.*` 和权限事件，POST 到桥；复制到 `~/.config/opencode/plugin/` 或项目的 `.opencode/plugin/` 即生效，不修改 opencode 配置。另提供 `hooks/claude/settings.example.json`（Stop/SubagentStop/Notification/PreToolUse/PostToolUse 示例）和 `hooks/README.md` 安装说明。`scripts/copy-runtime.mjs` 已加入 `hook-server.cjs`。

验证：`npm test` 107 passed, 0 failed（新增 hook server、hook client、pty-host env/路由、opencode 插件映射测试）；`npm run build` 通过，`dist/main/hook-server.cjs` 存在。剩余工作是 Windows 侧实际安装 opencode 插件/Claude 设置并跑真实任务，确认 opencode 事件字段与版本一致；`session.idle` 已弃用，插件同时处理 `session.status`。

## 6.16 稳定性与恢复批次（2026-11-06）

新增 `src/main/host-restart.cjs`，把 host 重启策略从固定 250ms 改成指数退避：250、500、1000、2000、4000、8000ms，最多 6 次；host 稳定运行超过 10 秒后重置重试预算；连续失败后给渲染器发 `pty:host-stopped`，由用户手动重启。`main.ts` 新增 `pty:restart-host` IPC、单实例锁（第二个实例聚焦已有窗口）、`state:save` 在落盘前统一 `sanitizeState()`；`hooks/README` 之外的 runtime 复制清单加入 `host-restart.cjs`。

渲染器新增 host 断开提示和“重启 PTY Host”按钮、终端级“重启终端”按钮；删除终端时显式 `dispose()` xterm 实例并清理 `terminalViews`/`fitAddons`/`consumedLocal` 引用；增加窗口 resize 和 `ResizeObserver` 的 fit 调度；PTY 输出的侧栏摘要改为 100ms 合并更新，xterm 写入仍然即时。

验证：`npm test` 111 passed, 0 failed（新增 host-restart 策略测试）；`npm run build` 通过；`dist/main/host-restart.cjs` 存在。Windows 侧仍需人工验证 host 崩溃恢复、窗口 resize 和长时间输出下的界面流畅度。

## 6.17 工作区体验与恢复入口（2026-11-06）

终端的 × 和工作区的 × 现在会先弹确认框，避免误点直接杀掉进程；设置面板补充了快捷键说明。新增 `Ctrl+Shift+T` 新建终端、`Ctrl+Shift+W` 关闭当前终端（走确认框）、`Ctrl+Shift+↑/↓` 在当前工作区内切换终端。窗口 resize 和 `ResizeObserver` 会触发当前终端的 `fit()`；PTY 输出摘要改为 100ms 合并更新，xterm 写入保持即时；删除终端时显式释放 xterm 实例和相关引用。host 断开时会显示失败原因和“重启 PTY Host”按钮，终端死后可在标题栏点“重启终端”用同一个 ID 重建 PTY。

验证：`npm test` 111 passed；`npm run build` 通过。Windows 侧需要人工检查：删除确认、三组快捷键、窗口缩放后的行列数、host 被任务管理器杀掉后的提示和重启、终端重建。

## 7. 新会话启动命令

```powershell
cd D:\01-cmcc\codes-win\75_TermBeacon
npm install
npm test
npm run build
npm start
```

新会话可直接使用 [docs/continuation-prompt.md](docs/continuation-prompt.md) 中的提示词，然后补充本次具体任务和验收标准；推进顺序见 [docs/development-plan-2026-11.md](docs/development-plan-2026-11.md)。

## 8. 当前交接结论

MVP 的核心架构、终端链路、持久化和打包已经落地。当前最重要的不是继续加功能，而是把状态检测从“单元测试正确”变成“真实终端可用”：先用定时 tick 和输入/证据过滤修好基础误判（本批次），再用三个真实 CLI 的录制样本校准 Registry 和 Hook，之后补 host 恢复、渲染资源管理和发布工程化。

## 6.18 布局、磁盘快照与发布更新（2026-11-06）

窗口大小、位置、最大化状态和侧栏宽度已经纳入 `state.json`，启动时恢复；侧栏边缘支持拖动调整，范围为 220–460px。终端输出以低频批次写入 `userData/terminal-history/<terminalId>.log`，单终端保留约 250KB，启动时恢复到 xterm，写入队列按终端串行化以避免并发截断。

正式包已接入 `electron-updater` 和 GitHub Releases 发布源。打包时可用 `GH_TOKEN` 发布，Windows 代码签名使用 `CSC_LINK`/`CSC_KEY_PASSWORD`，设置 `TERMBEACON_FORCE_SIGNING=1` 可强制缺证书时失败。已下载更新会在界面提示“重启并安装”；开发模式不会检查更新。

验证：`npm run build` 通过；`npm test` 112 passed, 0 failed。首次 GitHub 发布已在 6.20 完成（未签名）。

## 6.19 macOS 平台支持合并（2026-11-06）

macOS 平台支持已合并到 `main` 的 0.1.1 发布批次。macOS 默认 Shell 为 `/bin/zsh`，新建终端默认工作目录使用主进程返回的用户 Home；渲染器通过 `platform:info` IPC 获取运行时平台、Shell 和 CWD，保留 `/bin/bash` 作为可选 Shell。GUI 启动时继续补全用户 PATH，CLI discovery、PTY 参数校验、平台检测和 CLI smoke 测试均保留。

本次合并保留了 0.1.1 的 auto-update、hook bridge、PTY Host 恢复、工作区与窗口布局持久化、终端历史、CWD picker 和发布脚本。合并后应在 macOS 上执行 `npm run build`、`npm test`、`npm run smoke:cli`，并使用 `npm run dist:mac` 验证 Electron 打包。

## 6.20 首次 GitHub Release 发布（2026-11-06）

`v0.1.1` 已发布：https://github.com/FairmeHIT/TermBeacon/releases/tag/v0.1.1 。资产为 `TermBeacon-0.1.1-setup.exe`（95,719,188 B）、`.blockmap` 和 `latest.yml`，`latest.yml` 的 sha512 与安装包一致。安装包未签名（未配置 `CSC_LINK`），Windows 首次运行会出现 SmartScreen 提示。

发布流程问题：electron-builder 的 GitHub provider 配置为 `releaseType: "release"` 时，GitHub 要求 tag 已存在，否则创建 Release 返回 422 `Published releases must have a valid tag`。首次发布在 tag 推送前执行，exe 已上传成功，但 `latest.yml` 和 `.blockmap` 缺失；补推 tag 后用 GitHub Assets API 手工补传，并核对 `latest.yml` 的下载内容与本地一致。后续发布顺序应为：`git tag vX.Y.Z` → `git push origin vX.Y.Z` → `npm run dist:publish`（或用项目外输出目录加 `--publish always`）。

构建产物目录收敛为 `release/`：`release-out/` 是 2026-11-05 22:00/22:42 两次 EBUSY 失败构建残留的 `default_app.asar` 碎片（219 KB），已删除；`.gitignore` 保留该条目以防历史残留重现。`release/` 现含 0.1.1 安装包、blockmap、latest.yml 和 0.1.1 的 `win-unpacked`；0.1.0 旧包暂留。

验证：合并 macOS 平台支持后 `npm test` 119 passed, 0 failed；`npm run build` 通过。本次发布产物对应 tag `v0.1.1`（提交 `2eb02a2`）；`main` 上随后合入的 macOS 平台支持（`61033db`）尚未进入该安装包，需要下一版（0.1.2）发布。
