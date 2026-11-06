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
  let path = decodeURIComponent(match[2]);
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

function createOscParser(onTitle, onCwd) {
  let pending = "";

  function finish(text) {
    // text is the raw payload between "\x1b]N;" and the terminator.
    const semicolon = text.indexOf(";");
    if (semicolon <= 0) return;
    const code = text.slice(0, semicolon);
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
    let buffer = pending + chunk;
    let index = 0;
    while (index < buffer.length) {
      const intro = buffer.indexOf(OSC_INTRO, index);
      if (intro < 0) {
        // No sequence start: drop consumed text.
        pending = "";
        return;
      }
      const after = intro + OSC_INTRO.length;
      if (after >= buffer.length) {
        // Chunk ended right after ESC ]: wait for more data.
        pending = buffer.slice(intro);
        return;
      }
      // Find the terminator: BEL or ESC \, whichever comes first.
      const bel = buffer.indexOf("\x07", after);
      const escBack = buffer.indexOf("\x1b\\", after);
      const end = bel >= 0 && (escBack < 0 || bel < escBack)
        ? { index: bel, length: 1 }
        : escBack >= 0 ? { index: escBack, length: 2 }
        : undefined;      if (!end) {
        // Sequence not terminated yet. If it is huge, it is not a title.
        if (buffer.length - intro > MAX_PENDING_LENGTH) {
          index = intro + OSC_INTRO.length;
          pending = "";
          continue;
        }
        pending = buffer.slice(intro);
        return;
      }
      finish(buffer.slice(after, end.index));
      index = end.index + end.length;
    }
    pending = "";
  }

  return { feed };
}

module.exports = { createOscParser, sanitizeValue, decodeFileUri };
