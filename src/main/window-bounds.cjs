// Pure window-bounds math for the main process. Kept as CJS so tests can
// require it directly and scripts/copy-runtime.mjs can ship it.

function clamp(value, min, max) {
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, min), upper);
}

// A saved window can be larger than the current work area (smaller screen,
// display scaling, taskbar change) or positioned off-screen (monitor removed).
// Shrink it to the work area and pull it fully back into view instead of
// restoring it partly invisible.
function fitWindowToWorkArea(bounds, workArea) {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(workArea.width)));
  const height = Math.min(Math.max(1, Math.round(bounds.height)), Math.max(1, Math.round(workArea.height)));
  const x = clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width);
  const y = clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height);
  return { x, y, width, height };
}

// First launch has no saved bounds: center the preferred size, but never
// larger than the screen.
function centeredWindowBounds(size, workArea) {
  const width = Math.min(Math.max(1, Math.round(size.width)), Math.max(1, Math.round(workArea.width)));
  const height = Math.min(Math.max(1, Math.round(size.height)), Math.max(1, Math.round(workArea.height)));
  return fitWindowToWorkArea({
    x: workArea.x + (workArea.width - width) / 2,
    y: workArea.y + (workArea.height - height) / 2,
    width,
    height,
  }, workArea);
}

module.exports = { fitWindowToWorkArea, centeredWindowBounds };
