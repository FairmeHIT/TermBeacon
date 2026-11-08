<div align="center">
  <img src="docs/assets/termbeacon-cover.png" alt="TermBeacon - a clean control plane for every terminal" width="100%" />

  <p>
    <a href="https://github.com/FairmeHIT/TermBeacon/releases"><img src="https://img.shields.io/github/v/release/FairmeHIT/TermBeacon?style=flat-square" alt="Latest release" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-36-3b4856?style=flat-square" alt="Electron 36" /></a>
    <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-3b4856?style=flat-square" alt="React 19" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20%2B-3b4856?style=flat-square" alt="Node.js 20 or newer" /></a>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-3b4856?style=flat-square" alt="Windows, macOS, and Linux" />
  </p>

  <p><strong>Run every terminal in one clean view, and never miss a task finishing.</strong></p>
  <p>Works with <strong>Codex</strong>, <strong>Claude Code</strong>, <strong>OpenCode</strong>, and <strong>Pi</strong> — plus generic shells.</p>
</div>

<a id="termbeacon"></a>

TermBeacon is a local-first terminal manager for developers who run shells and CLI agents side by side. Keep multiple sessions in named workspaces, see what is working or waiting, and get a persistent reminder when a background task completes.

<p align="center">
  <img src="docs/assets/termbeacon-ui-preview.png" alt="TermBeacon simulated interface showing multiple terminals and task status history" width="100%" />
</p>

The image above is an illustrative UI preview. The application is an Electron desktop app with real local terminals, `node-pty`, xterm.js, task history, and CLI status bridges.

## Why TermBeacon

| Keep the flow visible | Keep the interface quiet | Keep control local |
| --- | --- | --- |
| Run shells, Codex, Claude Code, OpenCode, and Pi in parallel without losing the active session. | A compact sidebar, a focused terminal surface, and status lights that only ask for attention when it matters. | PTY sessions, history snapshots, and state stay on your machine. |

## Features

- **Multiple terminals and workspaces** - create, rename, switch, stop, restart, and remove sessions without losing background output.
- **Task status reminders** - see `Working`, `Completed`, `Ready`, `Waiting for input`, `Error`, and `Stopped` at a glance.
- **Completed-unseen state** - a finished task stays highlighted until you open that terminal, so background work does not disappear silently.
- **Agent CLI management** - detect, install, update, reinstall, switch sources, and roll back Codex, OpenCode, Claude Code, and Pi from a dedicated settings page. Managed installs are isolated under your user directory.
- **CLI status integrations** - native bridges for OpenCode, Claude Code, and Pi; inferred title/output detection for Codex.
- **Bilingual settings** - switch Settings between Simplified Chinese and English, with an immediately applied, saved preference.
- **Persistent sessions** - restore window layout, workspace selection, task history, and terminal scrollback after restarting the app.
- **Native terminal behavior** - xterm.js in the renderer, `node-pty` and Windows ConPTY in the host process, with a MessagePort data path for high-frequency output.
- **Light and dark themes** - switch the interface without changing terminal workflows.
- **Automatic updates** - packaged builds can check GitHub Releases and install a downloaded update after restart.

## Status model

| State | Meaning |
| --- | --- |
| `Working` | The terminal or agent is actively running a task. |
| `Completed` | A task finished while its terminal was not being viewed. It remains visible until you open it. |
| `Ready` | The session is idle and has been seen. |
| `Waiting for input` | The CLI needs a confirmation, permission, or another user response. |
| `Error` | The detector received an error signal or the process failed. |
| `Stopped` | The PTY exited. The terminal can be restarted from the workspace. |

Status signals are combined in this order: native Hook or plugin events, OSC title and progress signals, then conservative terminal text heuristics. See [`hooks/README.md`](hooks/README.md) for the integration details and known limitations.

## Quick start

### Use the packaged app

Download the latest installer from [GitHub Releases](https://github.com/FairmeHIT/TermBeacon/releases), install it for the current Windows user, and launch **TermBeacon**. The installer includes Electron, the renderer, the host process, `node-pty`, and the Windows ConPTY runtime; Node.js is not required on the target machine.

Open **Settings → Agent CLI** to detect or manage a CLI and configure its status bridge. The app itself does not need Node.js; managed CLI installation needs system Node.js and npm (Node.js 22.19 or a newer LTS is recommended for all four agents).

Managed installs keep system installations, credentials, and project configuration. Updates switch the launcher after version verification and retain the previous managed release for rollback. Running sessions keep running; reopen an existing terminal to refresh its PATH.

Use **Settings → General → Language / 语言** for the settings language. The terminal workspace currently remains in Chinese.

### Run from source

Requirements: Node.js 20 or newer, npm 10 or newer, and Git. Windows is required for ConPTY and Windows installer builds; macOS and Linux are supported for development and terminal usage.

```powershell
npm ci
npm run doctor
npm run build
npm test
npm run dev
```

Use `npm start` after `npm run build` to launch the built app. Run `npm run dist` on Windows to create an installer in `release/`.

## CLI status bridges

For the most accurate task status, install the optional bridges once in the environment where the CLI runs:

```powershell
npm run hooks:install
npm run hooks:configure:claude
npm run preflight:cli
```

- **opencode**: install the plugin, reload opencode, and use `opencode --standalone` so the plugin inherits the TermBeacon environment.
- **Claude Code**: merge the generated Hook into `~/.claude/settings.json`; the configurator makes a timestamped backup before writing.
- **Pi**: install its extension from Settings, or run `node scripts/hooks-install.cjs --configure-pi`.
- **Codex**: title/output inference is available without a Hook. It can be delayed or inaccurate when CLI formats change.
- **Generic shells**: prompt, output, and exit signals provide a conservative fallback.

The full setup, event mapping, troubleshooting guide, and protocol reference are in [`hooks/README.md`](hooks/README.md).

## How it works

```text
React renderer + xterm.js
          │
          │ MessagePort / IPC
          ▼
Detached PTY host + node-pty / ConPTY
          │
          ├── local shells
          ├── CLI agents
          └── Hook and OSC status signals
```

The host process owns PTYs independently from the window, so closing and reopening the UI does not stop a running terminal. A local socket connects the host to the main process; a MessagePort connects the main process to the renderer. Output credits are released after xterm parses each write, so PTY reads can pause when the renderer falls behind. Scrollback is written as bounded snapshots under Electron `userData`, and task records are stored alongside the persisted workspace state.

## Project docs

- [`hooks/README.md`](hooks/README.md) - install and troubleshoot CLI status bridges.
- [`docs/maintaining.md`](docs/maintaining.md) - architecture, verification, release process, and known limits.
- `src/` and `tests/` are the source of truth for the implementation and regression behavior.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite and Electron in development mode. |
| `npm run build` | Type-check main and renderer, build the renderer, and copy runtime assets. |
| `npm test` | Run the Node test suite. |
| `npm run doctor` | Check Node, npm, lockfile, and native dependency prerequisites. |
| `npm run preflight:cli` | Inspect installed CLIs and Hook/plugin configuration without changing files. |
| `npm run dist` | Build and verify the Windows installer without publishing. |
| `npm run dist:publish` | Build, verify, and publish the Windows release after its source commit and tag are pushed. |

## Project status

TermBeacon is an active MVP. The core desktop workflow is implemented; integrations and status detection continue to improve as more CLI event formats are covered. Contributions, reproducible bug reports, and sanitized CLI fixtures are welcome.
