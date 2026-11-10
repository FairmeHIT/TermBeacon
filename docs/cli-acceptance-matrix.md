# CLI 状态验收矩阵

更新：2026-11-10。本文记录 Windows x64 1.0 验收的当前基线。自动化 fixture 证明检测器行为；只有带 CLI 版本、真实任务记录和窗口结果的证据才能关闭正式发布门槛。

## 当前环境

| CLI | 版本 | 接入 | 当前结论 |
| --- | --- | --- | --- |
| Codex | 0.167.0 | 标题/输出推断 | 可做输出校准；不属于原生事件验收 |
| OpenCode 2 | 2.2.1 | V2 插件已安装 | 已完成真实任务验收；显式 `bifrost/wb-cn:deepseek-v4.1-flash#none` 路由可用 |
| Claude Code | 2.1.321 | Hook 已配置 | 已完成真实任务验收；权限等待和窗口重连已人工核对 |
| Pi | 1.5.0 | 扩展已配置 | 已完成真实任务验收；权限等待、错误、重试、长输出和窗口重连均已核对 |

生成当前机器报告：

```powershell
npm run acceptance:cli -- --json --out artifacts/cli-acceptance-report-YYYY-MM-DD.json
```

命令是只读的，只检查 CLI 版本、接入配置和 `tests/fixtures/agents/` 中的 fixture；存在阻塞项时返回退出码 `2`。

## Fixture 基线

| Agent | 数量 | 已覆盖状态 | 当前缺口 |
| --- | ---: | --- | --- |
| Claude Code | 22 | `working`, `completed-unseen`, `awaiting-input`, `error` | 16 个真实 fixture；真实权限等待和窗口重连已由用户人工确认，错误、重试和长输出已覆盖 |
| OpenCode 2 | 19 | `working`, `completed-unseen`, `awaiting-input`, `error` | 15 个真实 fixture；真实权限、重试、长输出、错误和窗口重连均已覆盖 |
| Codex | 5 | `working`, `completed-unseen`, `awaiting-input`, `error` | 无（仍为推断检测） |
| Generic shell | 4 | `working`, `completed-unseen`, `awaiting-input`, `error` | 无（非 1.0 原生 CLI） |
| Pi | 21 | `working`, `completed-unseen`, `awaiting-input`, `error` | 17 个真实 fixture；错误、长输出、重试、原生 `ctx.ui.confirm()` 等待链路和窗口重连均已覆盖；另有真实 `Insufficient Balance` 失败证据 |

## 真实任务验收

Claude Code、OpenCode 2 和 Pi 每个至少记录 10 个脱敏任务，覆盖以下场景：

| 场景 | 期望结果 |
| --- | --- |
| 普通任务开始 | `working` |
| 正常完成且未查看终端 | `completed-unseen` |
| 权限或确认请求 | `awaiting-input` |
| 网络、工具或 CLI 错误 | `error` |
| 临时失败后重试 | 维持 `working`，最终只接受新一轮结果 |
| 长输出和终端重绘 | 不误报完成，不丢失最终状态 |
| UI 重连或窗口重开 | 状态与 CLI 当前任务一致 |

每条记录需要保存 CLI 版本、任务场景、接入方式、TermBeacon 状态变化和最终人工核对结果。重连场景还必须在 fixture 中保留成对的窗口记录：`{"kind":"reconnect","source":"window","phase":"detached"}` 和 `{"kind":"reconnect","source":"window","phase":"attached"}`；只有这两条记录同时存在，验收报告才会计入真实重连证据。仅有 PTY host 或协议层重连记录不计入窗口验收。未完成真实任务验收前，fixture 通过不能视为 1.0 放行证据。

## 当前结论与剩余门槛

- 最新报告 `artifacts/cli-acceptance-report-2026-11-09.json` 的 Claude 权限等待、Claude 真实窗口重连和 Pi 真实窗口重连已由用户人工验证关闭；OpenCode 真实窗口重连也已由此前的用户验证 fixture 关闭。

- `release/TermBeacon-0.1.15-setup.exe` 已完成构建和 `verify:dist`。当前未配置 Authenticode 证书；这不阻塞 `0.1.15` 社区发布，但发布说明必须保留 SmartScreen 风险和 SHA-512 校验值。干净机器安装、升级、回滚和卸载仍是 `1.0.0` 的质量门槛。

- 安装与接入阻塞已解除：Codex、OpenCode 2、Claude Code 和 Pi 均已安装，三种原生接入均通过 `preflight --strict`。
- Claude 当前有 16 个明确标记为真实的脱敏任务 fixture，均为 Claude Code 2.1.319；真实权限等待、窗口重连、错误、重试和长输出均已通过。
- 当前机器的 Claude Code 已更新到 2.1.321；本次真实 fixture 的主要证据版本仍是 2.1.319，后续 CLI 版本变化应重新生成对应验收记录。
- OpenCode 当前有 15 个明确标记为真实的脱敏任务 fixture：显式 `bifrost/wb-cn:deepseek-v4.1-flash#none` 任务覆盖成功、权限等待、重试、长输出、错误和窗口重连，另有旧默认路由额度失败样本。
- Pi 当前有 17 个明确标记为真实的脱敏 fixture，均为 Pi 1.5.0；错误、长输出、重试、原生 `ctx.ui.confirm()` 等待链路和窗口重连均已通过。另保留 `Insufficient Balance` 真实失败证据，用于验证错误状态，不把账户额度问题误判为应用故障。
- Codex 的四种状态已有技术 fixture，但状态仍依赖标题/输出推断，不作为原生事件 CLI 验收对象。
