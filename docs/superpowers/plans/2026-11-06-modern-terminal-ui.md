# Modern Terminal UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle TermBeacon as a restrained graphite-and-cool-gray terminal workspace with cyan-blue accents and an edge-to-edge xterm canvas.

**Architecture:** Keep all React state, PTY/IPC behavior, and terminal lifecycle code unchanged. Update the existing renderer stylesheet and make only minimal JSX/theme adjustments in `App.tsx`.

**Tech Stack:** React 19, TypeScript, CSS, xterm.js, Electron, Vite, Node test runner.

## Global Constraints

- Do not modify PTY, Agent Registry, state machine, Hook, IPC, persistence, keyboard shortcuts, or terminal lifecycle behavior.
- Do not add dependencies, a component framework, a command palette, or new navigation.
- Preserve every existing operation and both dark and light themes.
- The terminal fills all workspace space below the header/update banners, without a card, grid, glow, radius, or outer padding.
- Preserve visible keyboard focus and add reduced-motion handling.
- Do not overwrite unrelated uncommitted user changes or perform Git mutations without explicit confirmation.

### Task 1: Apply the terminal-first visual system

**Files:**
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/App.tsx:99-104,736-794`

**Interfaces:**
- Consumes: Existing DOM class names, `Theme`, `terminalThemes`, `terminalStage`, `FitAddon`, and renderer handlers.
- Produces: Updated `terminalThemes` colors and, only if needed for truncation/accessibility, minimal non-behavioral JSX wrappers/attributes. No new application state or API.

- [ ] **Step 1: Replace decorative styling with graphite surfaces**

Set separate sidebar/workspace surface variables, readable cool-gray text, a restrained cyan-blue accent, 4–8px control radii, subtle borders, and shadows only on overlays. Remove sidebar and active-item gradients, hover translation, terminal grid/glow, and heavy card shadows.

```css
:root {
  color-scheme: dark;
  font-family: Inter, "Segoe UI", sans-serif;
  --app-bg: #101215;
  --panel-bg: #15181c;
  --panel-soft: #1b1f24;
  --panel-active: #20262d;
  --border: #292e35;
  --border-strong: #3c4855;
  --text: #e7eaf0;
  --text-soft: #bdc4ce;
  --muted: #8c97a5;
  --muted-strong: #9aa5b2;
  --quiet: #707b88;
  --accent: #6aa9e9;
  --terminal-bg: #101215;
  --sidebar-width: 300px;
}
```

Use equivalent neutral light tokens (`#f5f6f8` app, `#ffffff` terminal, `#20252c` text, `#2563a8` accent). Keep status colors semantically distinct and readable in both themes.

- [ ] **Step 2: Compact sidebar and header without changing behavior**

Keep the current order and handlers. Style workspace chips as quiet navigation rather than prominent pills. Use a left inset accent line and flat surface for the active terminal. Reveal destructive controls on `:hover`, `:focus-within`, and `:focus-visible`. Constrain header text with `min-width: 0`; truncate the cwd while keeping action buttons `flex-shrink: 0`.

```css
.terminal-item.active {
  border-color: var(--border);
  background: var(--panel-active);
  box-shadow: inset 2px 0 0 var(--accent);
}
.terminal-item:hover { background: var(--panel-soft); transform: none; }
.terminal-item:hover .terminal-remove,
.terminal-item:focus-within .terminal-remove { display: inline; }
.workspace-header > div:first-child { min-width: 0; }
.cwd-picker {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: "Cascadia Mono", Consolas, monospace;
}
.header-actions { flex-shrink: 0; }
```

- [ ] **Step 3: Make xterm fill the workspace**

Set `.terminal-stage` to `padding: 0; background: var(--terminal-bg)` and remove its pseudo-element. Set `.terminal-host` to `inset: 0; padding: 0; border: 0; border-radius: 0; background: var(--terminal-bg); box-shadow: none`. Keep `.xterm { height: 100%; }` and ensure `.xterm .xterm-viewport` uses the same background. Update `terminalThemes` to match the workspace exactly:

```ts
const terminalThemes: Record<Theme, { background: string; foreground: string; cursor: string }> = {
  dark: { background: "#101215", foreground: "#d7dce3", cursor: "#8ab8ed" },
  light: { background: "#ffffff", foreground: "#29313b", cursor: "#2563a8" },
};
```

Do not change `fitTerminal`, terminal creation, renderer IPC, or terminal options unrelated to colors.

- [ ] **Step 4: Normalize overlays, feedback, focus, and motion**

Restyle settings, task history, update banners, and host errors with the same surface/border tokens. Keep update banners in normal layout flow. Add `:focus-visible` treatment for buttons, selects, and title inputs. Add:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
```

- [ ] **Step 5: Build and run regression tests**

Run: `npm run build`  
Expected: TypeScript, Vite, and runtime copy all succeed.

Run: `npm test`  
Expected: All existing Node tests pass; no state/PTY/task regressions.

- [ ] **Step 6: Inspect the actual renderer**

Launch the existing Electron dev command only if a display session is available; otherwise use the Vite renderer with the existing Electron app. Check dark/light themes, long cwd/title truncation, terminal fit after sidebar/window resize, popovers, focus states, and reduced-motion CSS. Do not claim visual verification if only a build was run.

### Task 2: Final focused review

**Files:**
- Review: `src/renderer/App.tsx`
- Review: `src/renderer/styles.css`
- Reference: `docs/superpowers/specs/2026-11-06-modern-terminal-ui-design.md`

**Interfaces:**
- Consumes: Task 1 renderer changes.
- Produces: Verified UI-only diff and reported build/test/visual results.

- [ ] **Step 1: Audit the diff**

Run: `git diff -- src/renderer/App.tsx src/renderer/styles.css`  
Expected: Only visual tokens, styles, xterm colors, and explicitly needed non-behavioral markup/accessibility changes; no lifecycle or persistence edits.

- [ ] **Step 2: Check the design acceptance list**

Confirm there is no terminal card/padding/grid/glow, active/destructive/focus states work, all six terminal states remain textually identified, both themes are coherent, overlays use the same visual language, and reduced motion is supported.

- [ ] **Step 3: Report evidence and limitations**

Report exact build/test commands and results. Distinguish code/build verification from actual visual inspection. Leave unrelated modified files untouched and do not commit without explicit user confirmation.
