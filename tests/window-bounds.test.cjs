const test = require("node:test");
const assert = require("node:assert/strict");
const { fitWindowToWorkArea, centeredWindowBounds } = require("../src/main/window-bounds.cjs");

const smallDesktop = { x: 0, y: 0, width: 1280, height: 672 };
const laptop = { x: 0, y: 0, width: 1920, height: 1040 };
const secondDisplay = { x: 1920, y: 0, width: 1920, height: 1040 };

test("first launch shrinks the default size to a small work area", () => {
  assert.deepEqual(centeredWindowBounds({ width: 1280, height: 820 }, smallDesktop), {
    x: 0,
    y: 0,
    width: 1280,
    height: 672,
  });
});

test("first launch centers the default size on a large work area", () => {
  assert.deepEqual(centeredWindowBounds({ width: 1280, height: 820 }, laptop), {
    x: 320,
    y: 110,
    width: 1280,
    height: 820,
  });
});

test("restores a saved window that would sit above the top edge", () => {
  // The 820px default on a 672px work area used to produce y = -74.
  assert.deepEqual(fitWindowToWorkArea({ x: 0, y: -74, width: 1280, height: 820 }, smallDesktop), {
    x: 0,
    y: 0,
    width: 1280,
    height: 672,
  });
});

test("keeps a window that already fits on a secondary display", () => {
  assert.deepEqual(fitWindowToWorkArea({ x: 2200, y: 120, width: 1200, height: 800 }, secondDisplay), {
    x: 2200,
    y: 120,
    width: 1200,
    height: 800,
  });
});

test("pulls a window back in from the bottom-right corner", () => {
  assert.deepEqual(fitWindowToWorkArea({ x: 1000, y: 600, width: 800, height: 600 }, smallDesktop), {
    x: 480,
    y: 72,
    width: 800,
    height: 600,
  });
});

test("rounds fractional bounds and never returns a zero-size window", () => {
  const fitted = fitWindowToWorkArea({ x: 10.6, y: 20.4, width: 0, height: -5 }, smallDesktop);
  assert.deepEqual(fitted, { x: 11, y: 20, width: 1, height: 1 });
});
