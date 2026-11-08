/**
 * Streaming parser for OSC title (0/2) and cwd (7) sequences in PTY output.
 *
 * OSC sequences arrive embedded in raw output chunks and may be split across
 * chunk boundaries (a single \x1b]0;title\x07 write can arrive as two onData
 * calls). A stateful parser accumulates the pending sequence and only emits
 * once the terminator (BEL or ESC \\) arrives.
 *
 * - OSC 0 / 2: window title. Windows ConPTY converts SetConsoleTitle calls
 *   into these, and agent CLIs (Claude Code, opencode, codex) set their own
 *   titles, so this is free, reliable metadata.
 * - OSC 7: cwd as a file:// URI (used by shells and Claude Code on directory
 *   change) so the sidebar cwd stays current without a manual refresh.
 */

const OSC_INTRO = "\x1b]";

// Once a sequence is running longer than this, it is almost certainly not a
// title/cwd report (some other OSC use like clipboard or hyperlink payloads);
// abandon it instead of buffering unbounded garbage.
const MAX_PENDING_LENGTH = 512;

// Title/cwd values are UI strings; keep them short and strip control chars.
const MAX_VALUE_LENGTH = 120;

function sanitizeValue(value) {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, MAX_VALUE_LENGTH);
}

function decodeFileUri(uri, platform = process.platform) {
  const match = uri.match(/^file:\/\/([^/]*)(\/.*)$/);
  if (!match) return undefined;
  let path;
  try { path = decodeURIComponent(match[2]); } catch { return undefined; }
  // A drive-letter path is a Windows path regardless of the host platform.
  // This keeps captured Windows fixtures runnable on Linux/macOS CI.
  if (/^\/[a-zA-Z]:[\\/]/.test(path)) {
    return path.slice(1).replace(/\//g, "\\");
  }
  if (platform === "win32") {
    // file://host/C:/dir keeps a UNC form; treat it as a local drive too since
    // OSC 7 senders use an empty authority.
    return path.replace(/\//g, "\\");
  }
  return path;
}

function createOscParser(onTitle = () => {}, onCwd = () => {}, onProgress = () => {}) {
  let pending = "";
  let discarding = false;

  function finish(text) {
    // text is the raw payload between "\x1b]N;" and the terminator.
    const semicolon = text.indexOf(";");
    if (semicolon <= 0) return;
    const code = text.slice(0, semicolon);
    if (code === "9") {
      const progress = text.slice(semicolon + 1).match(/^4;(\d+);?(\d+)?$/);
      if (progress) onProgress({ state: Number(progress[1]), progress: progress[2] === undefined ? undefined : Number(progress[2]) });
      return;
    }
    const value = sanitizeValue(text.slice(semicolon + 1));
    if (code === "0" || code === "2") {
      if (value) onTitle(value);
      return;
    }
    if (code === "7") {
      const cwd = decodeFileUri(value);
      if (cwd) onCwd(cwd);
    }
  }

  function feed(chunk) {
    const buffer = pending + chunk;
    pending = "";
    const plain = [];
    let index = 0;
    while (index < buffer.length) {
      const intro = discarding ? index : buffer.indexOf(OSC_INTRO, index);
      if (intro < 0) {
        // Even the ESC byte of the introducer may arrive on its own.
        const trailingEscape = buffer.endsWith("\x1b");
        plain.push(buffer.slice(index, trailingEscape ? -1 : undefined));
        if (trailingEscape) pending = "\x1b";
        break;
      }
      if (!discarding) plain.push(buffer.slice(index, intro));
      const after = discarding ? intro : intro + OSC_INTRO.length;
      // Find the terminator: BEL or ESC \, whichever comes first.
      const bel = buffer.indexOf("\x07", after);
      const escBack = buffer.indexOf("\x1b\\", after);
      const end = bel >= 0 && (escBack < 0 || bel < escBack)
        ? { index: bel, length: 1 }
        : escBack >= 0 ? { index: escBack, length: 2 }
        : undefined;
      // A new introducer recovers from a truncated or abandoned sequence.
      const nextIntro = buffer.indexOf(OSC_INTRO, after);
      if (nextIntro >= 0 && (!end || nextIntro < end.index)) {
        discarding = false;
        index = nextIntro;
        continue;
      }
      if (!end) {
        if (discarding || buffer.length - intro > MAX_PENDING_LENGTH) {
          discarding = true;
          if (buffer.endsWith("\x1b")) pending = "\x1b";
        } else pending = buffer.slice(intro);
        break;
      }
      if (!discarding && end.index - intro <= MAX_PENDING_LENGTH) finish(buffer.slice(after, end.index));
      discarding = false;
      index = end.index + end.length;
    }
    // Return only visible text so titles, hyperlinks and clipboard payloads
    // cannot accidentally match task completion/error expressions.
    return plain.join("");
  }

  function reset() { pending = ""; discarding = false; }
  return { feed, reset };
}

module.exports = { createOscParser, sanitizeValue, decodeFileUri };
