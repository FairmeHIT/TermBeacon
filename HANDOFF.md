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

发布级：代码已接入 `release/` 输出、`electron-updater`、GitHub Releases 发布源和签名环境变量；当前阻塞项是没有证书的签名验证、崩溃日志、干净 Windows 环境的安装/升级/卸载回归，以及首次发布流程中 tag 与 `latest.yml` 的自动化修正。

已知边界：PTY 不跨应用重启存活，这是 v1 设计，不是 bug。host 崩溃会丢失内存输出缓冲和 PTY 会话，replay 只覆盖渲染器端口断开/重连。

## 5. 下一步建议

按 `docs/development-plan-2026-11.md` 执行。A-E 的代码批次已基本落地；下一步是批次 F 任务历史与接续工作，随后进行 G 真实 CLI 验收和 H 发布候选验证。

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

MVP 的核心架构、终端链路、布局/scrollback 持久化、host 恢复和自动更新代码路径已经落地。任务历史第一版已开始提供“重启后接续工作”的上下文，但仍需要 Windows 真机验证状态聚合和真实 CLI 任务样本。下一顺序是：真实 CLI Hook/fixture 验收、签名与干净环境发布验证、再根据 8 终端压力测试结果继续做性能优化。

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

## 6.21 状态校正与批次 F 启动（2026-11-06）

文档与源码状态已重新对齐：窗口尺寸/位置/最大化状态、侧栏宽度、终端 scrollback 磁盘快照、PTY host 退避重启、终端重建入口、自动更新配置和 macOS 打包路径均已实现。Windows 代码签名只完成配置入口，尚未提供 `CSC_LINK` 证书；`v0.1.1` 安装包因此为未签名版本，下一版发布前需要补签名并在干净 Windows 环境回归。

当前开始推进批次 F“任务历史与接续工作”：在已有终端状态事件之上增加任务级记录，持久化任务开始/结束时间、状态、摘要和错误，并在界面提供最近任务列表。该记录用于恢复上下文，不改变 PTY 不跨应用重启存活的 v1 边界。

## 6.22 任务历史第一版（2026-11-06）

新增 `TaskRecord` 共享类型和状态清洗逻辑。渲染器根据 `state:update` 聚合任务生命周期：进入 `working` 创建任务，进入 `awaiting-input` 保持未完成，进入 `completed-unseen`/`error`/`stopped` 记录结束时间和最终状态；PTY 退出、请求错误和 host 断开也会结束对应任务。任务提示词从用户回车提交的输入缓冲中提取，过滤 ANSI/控制序列并限制 500 字符。

任务记录作为 `state.json.tasks` 保存，单次最多保留 1000 条且只接受已知终端 ID；删除终端时同步删除任务记录。当前终端标题栏新增“任务历史”入口，显示最近 20 条任务、状态、时间、耗时和错误信息。旧版没有 `tasks` 字段的状态文件会自动按空列表兼容加载。

新增 `src/main/task-history.cjs` 和 `tests/task-history.test.cjs`，验证任务输入清洗；状态清洗测试覆盖孤立终端、非法时间和任务字段。

验证：`npm test` 122 passed, 0 failed；`npm run build` 通过；`git diff --check` 无实际格式错误；`npm start` 能启动 Electron，随后由本会话主动停止。Vite 仍提示 renderer bundle 大于 500KB，该警告未影响构建。

剩余限制：任务提示词依赖终端输入事件，TUI 内部提交可能没有可读文本；真实 Claude/Codex/opencode 任务仍需在 Windows 环境安装 Hook/插件后验收；当前未执行签名发布和干净环境升级测试。

## 6.23 真实 CLI 预检批次（2026-11-06）

新增只读 `scripts/cli-preflight.cjs` 和 `npm run preflight:cli`。它检查已安装 CLI 版本、Hook 客户端、用户目录下的 opencode 插件和 Claude settings 是否包含 `termbeacon-hook.cjs`，支持 `--json` 输出和 `--strict` 验收模式，不会修改用户配置或调用模型。

本机实测：opencode v2.2.1、Codex CLI 0.166.0、Claude Code 2.1.318 的 `--version` 和 `--help` 均通过；Hook 客户端和插件源码语法通过；`C:\Users\fairm\.config\opencode\plugin\termbeacon.js` 已存在。`C:\Users\fairm\.claude\settings.json` 仍未配置 TermBeacon Hook，因此 `npm run preflight:cli -- --strict` 按预期返回退出码 1。

新增预检测试后，`npm test` 为 134 passed，`npm run build` 通过。opencode 插件现在已安装，下一步只需合并 Claude Hook 设置，再执行最小任务、权限等待、失败和 `Ctrl+C` 四类真实场景；本阶段不自动发起可能产生 API 消耗的模型任务。

## 6.24 Claude Hook 配置器（2026-11-06）

新增 `npm run hooks:configure:claude`，以及 `scripts/hooks-install.cjs --configure-claude`。配置器默认目标为用户级 `~/.claude/settings.json`，支持 `--project` 写入当前项目的 `.claude/settings.json`，也支持 `--settings <path>` 指定文件。它解析并保留已有顶层字段和 Hook，只追加缺失的 TermBeacon Hook；已有配置会先生成带时间戳的 `.bak-*` 备份，再通过临时文件原子替换，重复执行保持幂等。JSON 无效时直接失败且不写回原文件。

默认的 `preflight:cli` 仍是只读检查，不会自动调用配置器；只有显式执行 `hooks:configure:claude` 才会修改 Claude settings。下一阶段在用户确认配置已就绪后，再进行真实 CLI 的最小任务、权限等待、失败和 `Ctrl+C` 验收，避免未经授权产生模型调用费用。

验证：`npm test` 137 passed，`npm run build` 通过，`npm run preflight:cli -- --json` 输出当前三种 CLI 与 Hook 就绪状态；严格预检仍因本机 Claude settings 尚未配置而按预期返回退出码 1。

## 6.25 真实 CLI 验收准备与 capture 审计（2026-11-06）

新增只读 `scripts/cli-capture-audit.cjs` 和 `npm run audit:cli-capture`。它解析 `cli-record` 生成的 JSONL，只输出 agent/version、时长、记录与字节统计、OSC 标题信号数量、输入记录数量、错误数、退出回执和结构审计结论，不输出提示词、终端正文或原始环境字段。`fixtureEligible` 只表示存在 meta、任务输入、自然退出且无录制错误；`reviewReasons` 明确缺失退出、非零退出或录制错误等原因。新增测试覆盖格式错误、超时 capture 和敏感正文不泄露。

新增 `scripts/cli-capture-to-fixture.cjs` 和 `npm run fixture:from-capture`。转换器要求显式 `--sanitized`，剥离命令、可执行路径、平台、启动时间等环境元数据，默认把输入替换为 `[task]`，保留回放需要的 output/tick/hook，补充用户指定的 `assert.state`，并丢弃 capture 的 exit/error 记录。它不会自动声称业务成功；输出流和期望状态仍需人工复核。

本机无模型调用的 ConPTY 冒烟矩阵已通过：`npm run smoke:cli -- --version` 与 `npm run smoke:cli -- --help` 均对 opencode v2.2.1、Codex CLI 0.166.0、Claude Code 2.1.318 返回退出码 0。审计现有 capture 的结果是：Claude 任务录制有自然退出回执；Codex 和 opencode 录制达到录制时限后停止，没有自然退出回执，因此只能作为诊断材料，不能当作真实任务成功证据。

当前工作区已将 opencode 插件测试更新到 V2 `default export + setup(ctx)` 契约，避免插件迁移后旧 V1 测试误报。验证：`npm test` 139 passed，`npm run build` 通过，capture 审计命令通过。随后只读预检发现 Claude Hook settings 已配置，`npm run preflight:cli -- --strict` 现已通过，说明真实交互验收前置条件就绪。下一步仍需用户在已配置账号的 Windows 环境中手动完成最小任务、权限等待、失败和 `Ctrl+C` 四类真实场景；本阶段不自动触发模型调用。

## 6.26 Capture 到 fixture 的受控转换（2026-11-06）

新增 `scripts/cli-capture-to-fixture.cjs` 和 `npm run fixture:from-capture`。转换器要求显式传入 `--sanitized`，剥离原始命令、可执行路径、平台和启动时间等环境元数据，默认把输入替换为 `[task]`，保留回放所需的 output/tick/hook，补充指定的 `assert.state`，并丢弃 capture 的 exit/error 记录。它只处理人工审核后的 capture，不把转换结果自动视为业务成功。

验证：`npm test` 147 passed，`npm run build` 通过；用现有 Claude capture 做过生成流程验证后已删除临时输出，未把未人工脱敏的真实终端正文加入仓库。`npm run preflight:cli -- --strict` 继续通过。

## 6.27 Claude 真实标题派生 fixture（2026-11-06）

从现有 Windows Claude capture 中只提取白名单标题 `◐/◑/✳ Claude Code`，加入 `tests/fixtures/agents/claude-real-title-task.jsonl`。fixture 使用 `[task]` 脱敏输入和最终 `completed-unseen` 断言，保留真实时间间隔，任务正文、命令、路径和退出记录均未写入。它验证 Claude 的 OSC 标题工作/空闲检测路径，不代表 Claude Hook、权限等待或业务结果已经完成验收。

验证：`npm test` 148 passed，`git diff --check` 通过。下一份真实 fixture 应覆盖 Hook `Stop` 或权限 `Notification` 事件，并继续保持正文脱敏。

录制器新增可选 `--hook-log`。启用后会为被录制 CLI 启动独立 loopback Hook bridge，把收到的事件以 `{ kind: "hook", event, status, at }` 写入同一 capture，并在退出时关闭 bridge；默认关闭，不改变既有录制路径。下一次 Claude/opencode 真实录制可同时保留输出和 Hook 证据。

本地 fake CLI 验证已确认 `UserPromptSubmit → running` 与 `Stop → completed` 能写入 capture，且进程自然退出；新增录制器参数回归测试。真实 Claude 权限/完成场景仍需在实际 CLI 中录制。

## 6.28 录制器 Hook bridge 回归（2026-11-06）

修复 `scripts/cli-record.cjs` 对 `--hook-log` 的参数解析：带连字符的布尔选项现在正确映射为 `hookLog`。新增 `tests/cli-record.test.cjs`，覆盖 Hook 开关和输入过滤；本地 fake CLI 通过录制器验证了 `UserPromptSubmit`/`Stop` Hook 事件、bridge 环境注入和自然退出清理。

验证：`npm test` 150 passed，`npm run build` 通过，`git diff --check` 通过。临时 fake CLI 和 capture 已删除。

## 6.29 终端标题、CLI 标签与工作区顶栏修复（2026-11-06）

本轮修复左侧终端栏和右侧工作区顶栏：

- `TerminalInstance.titlePinned` 记录用户是否手动重命名。保存到 `state.json`，恢复时自动回填旧版状态文件，并阻止 shell/CLI 的 OSC 0/2 标题覆盖用户标题。
- 恢复终端时将运行态 `agentType` 重置为 `generic`，等待本次 PTY 输出重新识别 Codex、Claude Code 或 opencode；因此没有启动 opencode 的终端不会显示旧的 opencode。
- Windows 主进程和渲染器 fallback 默认 Shell 改为 `powershell.exe`；cmd.exe、PowerShell 7 仍在设置选项中保留。
- 左侧条目移除第三行 cwd/输出摘要，只保留标题、CLI 或 Shell 名称和状态。
- 右侧顶栏移除重复的可编辑标题，只保留可点击的当前项目路径；路径选择行为不变。
- 状态保存防抖从 1000ms 调整为 150ms，降低改名后快速退出导致的丢失窗口。

验证：`npm test` 151 passed，`npm run build` 通过。待 Windows 真机手工验收：改名后立即关闭并重启、旧 `state.json` 迁移、PowerShell 默认提示符，以及运行 CLI 后标签是否更新为实际 CLI 名称。

## 6.30 0.1.8 发布与工作区清理（2026-11-06）

本批把此前未提交的任务历史、真实 CLI 工具链和终端标签修复合并为 0.1.8：

- 任务历史第一版（`TaskRecord`、`state.json.tasks`、“任务历史”面板）与 `src/main/task-history.cjs`。
- 只读的 `preflight:cli`、`audit:cli-capture`、`fixture:from-capture` 脚本和 `hooks:configure:claude` 幂等配置器。
- 录制器 `--hook-log`、opencode 插件 V2 契约测试，以及脱敏派生的 `claude-real-title-task.jsonl`。
- `titlePinned` 标题固定、恢复时重置 `agentType`、Windows 默认 PowerShell、可折叠侧栏和 150ms 状态保存防抖。
- 本地验证产物目录 `artifacts/` 加入 `.gitignore`，不再入库；仓库只保留源码、文档和测试。

验证：`npm test` 153 passed, 0 failed；`npm run build` 通过。`v0.1.8` 已发布：https://github.com/FairmeHIT/TermBeacon/releases/tag/v0.1.8 ，资产为 `TermBeacon-0.1.8-setup.exe`（95,723,340 B）、`.blockmap` 和 `latest.yml`；重新下载安装包计算出的 sha512 与 `latest.yml` 一致。安装包仍为未签名版本（未配置 `CSC_LINK`），Windows 首次运行会出现 SmartScreen 提示。

## 6.31 发版流程固化为项目 skill（2026-11-06）

新增 `.opencode/skills/release/`，把 0.1.8 的实际发版过程固化为 OpenCode 项目级 skill（ID `release`，会自动发现）：

- `SKILL.md`：硬性规则（先推 tag 再建 Release、产物不入库、未签名如实说明）+ 9 步流程 + 故障处置表。
- `scripts/create-release.mjs`：创建/复用 GitHub Release 并上传 `exe`、`.blockmap`、`latest.yml`；上传前校验 `--version` 与 `latest.yml` 一致、本地 sha512 与清单一致；`--verify-download` 重新下载并比对；`--dry-run`、`--verify-only` 供复查；token 优先取 `GH_TOKEN`/`GITHUB_TOKEN`，回退 `git credential fill`（本机无 `gh` CLI）。
- `references/lesson-log.md`：422、EBUSY、api.github.com 超时、更新源是 `github.com/releases.atom`、未签名、`release/` 累积、PowerShell 伪失败等踩坑记录。

修正 `.gitignore`：`release/` 改为 `/release/`，避免误伤 `.opencode/skills/release/`。

验证：`npm test` 157 passed, 0 failed（新增 `tests/release-skill.test.cjs` 覆盖 `parseArgs`、`parseLatestYml`、`sha512File` 与无副作用导入）；`create-release.mjs --version 0.1.8 --dry-run`、`--verify-only` 与幂等重跑（全部 skip）均通过。
