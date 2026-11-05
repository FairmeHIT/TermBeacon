# TermBeacon MVP

后续开发请先阅读 [交接文档](HANDOFF.md)、[开发推进提示词](docs/continuation-prompt.md)、[开发手册](docs/development-handbook.md) 和 [工程 Spec](docs/termbeacon-engineering-spec.md)。

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

MVP 当前包含：

- Electron + React + TypeScript + Vite。
- xterm.js + FitAddon 终端视图。
- node-pty + Windows ConPTY。
- 独立 Electron utility process 运行 `pty-host`。
- MessageChannelMain/MessagePort 高频 PTY 数据面。
- 多终端创建、切换、停止和后台输出保留。
- 工作中、已完成未查看、就绪、等待输入、异常、已停止状态灯。
- 基于 prompt、输入和基础等待输入模式的第一版状态检测。

当前状态检测已抽出 Agent Registry，并提供 opencode、Codex、Claude Code 和 generic CLI 的 JSONL fixture 回放测试。原生 Hook 已提供统一入口，OSC 9;4 适配将在下一迭代加入。


