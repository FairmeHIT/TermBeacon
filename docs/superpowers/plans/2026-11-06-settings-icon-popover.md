# 设置图标与浮层遮挡修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将设置入口改为协调的三行滑块图标，并消除设置浮层的侧栏裁切。

**Architecture:** 保留 React 状态与设置内容，仅替换 SVG 并把浮层移到应用根布局。CSS 使用应用根布局和现有侧栏宽度变量定位浮层。

**Tech Stack:** React 19、TypeScript、CSS、Node 内置测试运行器、Electron/Vite。

## Global Constraints

- 仅修改设置图标、浮层挂载位置及必要样式。
- 不改动设置项、设置行为或侧栏宽度逻辑。
- 不提交或改动用户已有的无关修改。

---

### Task 1: 设置入口与浮层修复

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/renderer-settings.test.cjs`

**Interfaces:**
- Consumes: 现有 `settingsOpen` 状态、`setSettingsOpen`、`sidebarWidth` 与 `.sidebar-footer`。
- Produces: 三行滑块 `SettingsIcon`，以及不受侧栏 overflow 裁切的 `.settings-popover`。

- [ ] **Step 1: 编写失败的结构回归测试**

使用 `node:test` 和 `node:assert/strict` 读取 `App.tsx` 与 `styles.css`，断言图标包含三条水平滑轨和三个滑块，并断言设置浮层不再位于 `.sidebar-footer` 内，且使用不受侧栏 overflow 影响的定位变量。

- [ ] **Step 2: 验证测试因当前实现失败**

Run: `node --test tests/renderer-settings.test.cjs`

Expected: FAIL，指出当前齿轮 SVG 或侧栏内浮层不符合目标结构。

- [ ] **Step 3: 最小实现**

在 `SettingsIcon` 中绘制 `viewBox="0 0 24 24"` 的三行滑轨与三个圆形滑块；保留原有 SVG 样式。将 `{settingsOpen && <div className="settings-popover">…</div>}` 整块移到 `<aside className="sidebar">` 之后、根 `<main>` 内，内容不变。浮层使用 `left: calc(var(--sidebar-width) - 226px)` 与 `bottom: 47px`，保持贴近原入口。

- [ ] **Step 4: 运行回归与完整验证**

Run: `node --test tests/renderer-settings.test.cjs`

Expected: PASS。

Run: `npm test`

Expected: 全部测试通过。

Run: `npm run build`

Expected: TypeScript 与 Vite 构建成功。

- [ ] **Step 5: 界面验证**

启动 Electron 开发界面，分别检查深浅主题和默认/调整后侧栏宽度，确认浮层完整可见且图标与主题按钮风格一致。保留截图供核验。
