# Maintaining TermBeacon

Updated: November 8, 2026. Current implementation and tests take precedence over historical design notes.

## Responsibilities and shared paths

- `src/main/pty-host.cjs` owns PTYs, the authenticated localhost event bridge, detectors, and replay. The detached host survives UI restarts. A local socket connects it to Electron main; main relays messages over a MessagePort to preload and xterm.
- `src/main/output-flow.cjs` shares a 512 KiB output credit budget, with a 128 KiB low watermark. ACK follows xterm's write callback. Detaching releases pressure; reconnect requests unconsumed replay. `pty:forget` releases a terminal's queues and state.
- Live replay retains up to 2 MiB per terminal. Exited replay has a shared 16 MiB budget and five minute TTL. Disk history uses serialized operations, a 400,000 byte limit and a 250,000 byte retained tail, without splitting UTF-8 characters.
- `src/main/detection-engine.cjs` is the shared state machine; `agent-registry.cjs` holds CLI patterns. Native events own a turn once received. Child completion, old timestamps, retry duplicates, and terminal redraws must not override the root task's state. Before native events arrive, conservative title/output inference is available; silence alone is insufficient.
- `src/main/cli-manager.cjs` owns the CLI catalog, asynchronous probes, installation plans, pinned versions, source selection, and rollback. `cli-runtime.cjs` handles direct invocation and shell quoting. Development discovery, smoke, and recorder scripts use this same manager; resume adapters return arguments to the same launch service. Avoid adding another `where`/shell/version implementation.
- `src/main/integration-config.cjs` owns configuration paths, content checks, backups, and Hook/extension installation. Both Settings and `hooks-install.cjs` use it, respecting `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, and `PI_CODING_AGENT_DIR`.
- `SettingsPage.tsx` owns the independent settings view. Terminal DOM and xterm instances stay mounted. `settings-i18n.ts` translates both page text and first-party backend messages at render time; commands, paths, and unknown external diagnostics remain unchanged. `termbeacon-settings-language` persists the settings language.

## Managed CLI contract

Managed releases live under `~/.termbeacon/agents/<id>/releases/<version>-<uuid>`, with launchers under `~/.termbeacon/agents/bin`. New PTYs prepend that bin directory to PATH. System installs, credentials, and project files are preserved. Configuration and CLI operation previews require an explicit confirmation in the UI.

Only allowlisted packages and operations are accepted. A short lived, single use preview token binds the operation to the current manifest. Operations lock per agent; manifest writes serialize across agents. Installation, rollback, and reselecting a managed source verify the version before changing its launcher. A failed manifest write restores the launcher. Launcher and manifest updates are separate atomic writes with error rollback; abrupt power loss between them is not a fully atomic transaction. Failed downloads can leave an unused release directory.

| CLI | Package | Status source |
| --- | --- | --- |
| Codex | `@openai/codex` | Title/output inference; native lifecycle integration is unavailable |
| OpenCode 2 | `@opencode/cli` | Plugin events and session reconciliation, with `--standalone` |
| Claude Code | `@anthropic-ai/claude-code` | Native Hooks for root tasks and permission requests |
| Pi 1 | `@earendil-works/pi-coding-agent` | Extension events; final completion uses `agent_settled` |

The desktop runtime bundles Electron and does not require system Node.js. Managed npm installation does: Node.js 22.19 or a newer LTS covers all four current packages. Pi uses `--ignore-scripts`; managed Claude disables its independent auto-updater so TermBeacon controls its version.

## Verification

Run from a clean dependency install when setting up a machine:

```powershell
npm ci
npm run doctor
npm run build
npm test
npm run preflight:cli
npm run smoke:cli
```

Build before tests: runtime regression tests inspect copied modules in `dist`. Build type-checks main and renderer. `preflight:cli` and CLI smoke do not submit model prompts. Preflight reports configuration readiness, not successful live event delivery. `--strict` checks installed native-event agents; absent optional CLIs do not block it, and Codex alone cannot satisfy native-event readiness.

When changing transport, exercise real ConPTY output, write acknowledgements, replay, deletion, and detached reconnect with an isolated profile. When changing Settings, check both languages and themes, narrow widths, preview/cancel, execution rejection, reopening/reloading, and retained terminal identity. Plugin loader smoke and synthetic fixtures do not establish paid model-task accuracy.

## Windows release

1. Review the diff and untracked source files. Exclude `artifacts`, `captures`, build output, credentials, and personal workflow files. Update user documentation and release notes.
2. Run build and tests, commit the feature/fix batch, then update `package.json` and both root versions in `package-lock.json` together. Commit the version change separately.
3. Push `main`, create an annotated `vX.Y.Z` tag at the version commit, and push the tag. Verify both remote refs.
4. Run `npm run dist`. The wrapper calls electron-builder with argument arrays and `--publish never`, uses a fresh scratch directory, copies `latest.yml` last, and fails on any required copy error. `TERMBEACON_BUILD_DIR` optionally selects the scratch parent. `TERMBEACON_ELECTRON_DIST` can point to an extracted matching Electron distribution when downloads are blocked.
5. `verify:dist` requires the exact version's installer and blockmap, both manifest hashes and size, matching packaged version, matching built runtime files and Hook resources, and node-pty/ConPTY binaries. Older installers in `release/` cannot satisfy the check.
6. Write release notes to a local file, then run:

```powershell
node scripts/create-release.mjs --notes-file .release-notes.md --dry-run
node scripts/create-release.mjs --notes-file .release-notes.md --verify-download
node scripts/create-release.mjs --verify-only
```

`dist:publish` combines build, verification, and publishing; it still requires pushed source/tag and prepared notes. The publisher uses `GH_TOKEN`/`GITHUB_TOKEN`, or Git Credential Manager without printing credentials. It creates a draft, uploads and verifies all three assets, checks the remote installer when requested, then publishes and checks GitHub latest. Matching hashes make reruns idempotent; differing published assets require a new version. The maintained publisher and artifact validator are tracked in `scripts/`; personal skill copies are compatibility wrappers only.

## Release limits and upgrade behavior

- Windows x64 is the validated release target. macOS build configuration and Unix shell paths exist; native macOS/Linux acceptance is separate.
- Without `CSC_LINK`, the Windows installer is unsigned. State this in release notes; SmartScreen may prompt. Clean-machine install/upgrade/uninstall and signing acceptance require a suitable separate environment.
- Closing or updating the UI preserves its detached host and running PTYs. To load a new detector/PTY runtime, finish current tasks and use **Settings → General → Restart service**. This explicitly closes all terminal and Agent processes. Do not force it as part of publishing.
- A machine reboot or host crash cannot restore the original process. Session resume launches a supported CLI's resume command; it does not replay the original prompt.
- Configuration checks and native loader checks are distinct from real model-turn acceptance. Codex inference, CLI version changes, and network outages remain observable limits.
