/**
 * Produce a short, human-readable "last activity" line from a raw PTY chunk.
 *
 * The sidebar shows this under the terminal title, so it must never contain
 * terminal control sequences or decoration glyphs: earlier versions stripped
 * only simple CSI codes, so OSC titles, cursor movement and box-drawing/spinner
 * characters leaked through and rendered as mojibake while an agent was busy.
 */

// OSC (BEL or ST terminated), CSI, and remaining single-character escapes.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESCAPES = /\u001b[@-_]/g;
// Control characters except newline/tab, plus C1 range and zero-width marks.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;
// Box drawing, block elements, geometric shapes and braille spinners: these are
// pure decoration and are what turned the sidebar line into garbage.
const DECORATION = /[\u2500-\u257f\u2580-\u259f\u25a0-\u25ff\u2800-\u28ff]/g;

const MAX_LENGTH = 90;

// A line is worth showing only if it carries a couple of "real" characters:
// letters (Latin or CJK) or digits. Progress bars and cursor debris fail this.
function isMeaningful(line) {
  const hits = line.match(/[0-9A-Za-z\u00c0-\u024f\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  return (hits?.length ?? 0) >= 2;
}

function summarize(chunk) {
  if (!chunk) return undefined;
  const plain = String(chunk)
    // Normalise newlines before stripping control characters, otherwise CR
    // (used by progress bars to overwrite a line) is deleted and separate
    // progress updates concatenate into one bogus line.
    .replace(/\r\n?/g, "\n")
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESCAPES, "")
    .replace(CONTROL, "")
    .replace(DECORATION, "");

  const lines = plain
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0 && isMeaningful(line));

  const last = lines[lines.length - 1];
  if (!last) return undefined;
  return last.slice(-MAX_LENGTH);
}

module.exports = { summarize, isMeaningful, MAX_LENGTH };
