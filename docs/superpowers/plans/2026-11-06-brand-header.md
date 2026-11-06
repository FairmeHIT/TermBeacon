# Brand Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidebar's text-only heading and subtitle with a polished beacon logo and the single TermBeacon product name.

**Architecture:** Add a decorative inline SVG component alongside the existing icon components in `App.tsx`. Use scoped CSS and existing theme variables to create a compact, responsive brand lockup without dependencies or functional changes.

**Tech Stack:** React 19, TypeScript, CSS, Node test runner, Electron.

## Global Constraints

- Display only “TermBeacon”; remove “CLI Agent 工作台”.
- Use an abstract beacon, not AI, robot, TB-letter, or terminal-cursor imagery.
- Preserve the new-terminal control and all other application behavior.
- Modify only the renderer brand markup/styles and focused regression coverage.

---

### Task 1: Brand lockup and beacon mark

**Files:**
- Modify: `tests/renderer-settings.test.cjs`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Produces: `BrandMark(): React.JSX.Element`, a decorative SVG inside `.brand-lockup`.
- Consumes: existing `.brand-row`, `.brand-actions`, `--accent`, `--text`, and sidebar theme variables.

- [ ] **Step 1: Write the failing regression test**

Add this test to `tests/renderer-settings.test.cjs`:

```js
test("brand header uses a beacon mark and only the product name", () => {
  const brandRow = app.match(/<div className="brand-row">([\s\S]*?)<\/div><div className="workspace-bar">/)?.[1];
  assert.ok(brandRow, "brand row must exist");
  assert.match(brandRow, /<BrandMark\s*\/>/);
  assert.match(brandRow, /className="brand">TermBeacon<\/div>/);
  assert.doesNotMatch(brandRow, /CLI Agent|工作台|subtitle/);
  const mark = app.match(/function BrandMark\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(mark, "BrandMark must exist");
  assert.match(mark, /aria-hidden="true"/);
  assert.match(styles, /\.brand-mark\s*\{/);
  assert.match(styles, /\.brand-lockup\s*\{/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/renderer-settings.test.cjs`
Expected: the new test fails because `BrandMark` and the new classes do not exist.

- [ ] **Step 3: Implement the minimal brand component**

Add `BrandMark` beside the existing icon functions in `App.tsx`:

```tsx
function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect className="brand-mark-tile" x=".5" y=".5" width="31" height="31" rx="9.5" />
    <path className="brand-mark-signal" d="M16 10a6 6 0 0 1 6 6M16 5a11 11 0 0 1 11 11" />
    <circle className="brand-mark-core" cx="16" cy="19" r="4" />
    <path className="brand-mark-base" d="M12 26h8" />
  </svg>;
}
```

Replace the brand row with:

```tsx
<div className="brand-row"><div className="brand-lockup"><BrandMark /><div className="brand">TermBeacon</div></div><div className="brand-actions"><button className="add-button" onClick={addTerminal} title="新建终端" aria-label="新建终端"><PlusIcon /></button></div></div>
```

The implementer may refine SVG path geometry and CSS values within the approved 28–32px abstract-beacon design. Use a 32px row, 30px tile, `min-width: 0` and `flex: 1` on `.brand-lockup`, non-shrinking `.brand-mark`, `white-space: nowrap` on `.brand`, and theme-sensitive tile/signal/core colors. Remove `.subtitle` only if it has no other consumers.

- [ ] **Step 4: Run focused and full verification**

Run: `node --test tests/renderer-settings.test.cjs`
Expected: all tests pass.

Run: `npm test`
Expected: all tests pass.

Run: `npm run build`
Expected: TypeScript, Vite, and runtime-copy steps exit successfully.

- [ ] **Step 5: Verify the rendered header**

Load the built renderer in Electron, inspect the brand in dark/light themes and a narrow supported sidebar, and capture screenshots. Confirm the SVG is visible, TermBeacon is not clipped, the add button remains aligned, the subtitle is absent, and the renderer reports no errors.
