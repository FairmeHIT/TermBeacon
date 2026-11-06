/**
 * Keep alternate-screen TUI repaint traffic out of the persistent terminal
 * history. OpenCode and similar clients use DEC private modes while handling
 * mouse scrolling; replaying those repaint commands as shell scrollback makes
 * the screen look duplicated or out of order.
 */
export type ScreenOutput = {
  normalData: string;
  alternate: boolean;
};

const ALTERNATE_MODES = new Set([47, 1047, 1049]);
const PRIVATE_MODE = /\x1b\[\?([0-9;]+)([hl])/g;

export function splitScreenOutput(data: string, initialAlternate = false): ScreenOutput {
  if (!data) return { normalData: "", alternate: initialAlternate };

  let alternate = initialAlternate;
  let cursor = 0;
  let normalData = "";
  PRIVATE_MODE.lastIndex = 0;

  for (const match of data.matchAll(PRIVATE_MODE)) {
    const index = match.index ?? 0;
    if (!alternate) normalData += data.slice(cursor, index);

    const modes = match[1].split(";").map((value) => Number(value));
    if (modes.some((mode) => ALTERNATE_MODES.has(mode))) {
      alternate = match[2] === "h";
    }
    // A private-mode sequence that does not switch screens is normal output
    // when it arrives on the normal screen. Repaint traffic is discarded only
    // while alternate is active.
    if (!alternate && !modes.some((mode) => ALTERNATE_MODES.has(mode))) {
      normalData += match[0];
    }
    cursor = index + match[0].length;
  }

  if (!alternate) normalData += data.slice(cursor);
  return { normalData, alternate };
}
