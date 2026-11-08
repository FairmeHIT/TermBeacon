/**
 * Automatic CLI agent identification from terminal output.
 *
 * The renderer used to make the user pick an agent type from a dropdown, which
 * exposed an internal detail: the detection engine's pattern set. Users just
 * type `claude` and expect the status light to work. This module sniffs the
 * first kilobytes of PTY output for each CLI's own banner/identity strings and
 * reports the agent type, so no manual selection is needed.
 *
 * Signatures are deliberately narrow (product names in a banner-ish position)
 * because a wrong guess would apply the wrong completion patterns and make the
 * status light lie.
 */

const MAX_SCAN_BYTES = 8 * 1024;

// Ordered most-specific first: `opencode` output can mention "claude" in
// prompts, and Claude Code mentions nothing about codex, but ordering removes
// any ambiguity when several signatures appear in one banner.
const SIGNATURES = [
  { agent: "pi", patterns: [/\bpi coding agent\b/i, /\bpi\s+v?\d+\.\d+\.\d+\b/i] },
  { agent: "claude", patterns: [/Claude Code/i, /✻\s*Welcome to Claude/i, /claude\.ai\/code/i] },
  { agent: "opencode", patterns: [/\bopencode\b/i] },
  { agent: "codex", patterns: [/\bOpenAI Codex\b/i, /Codex CLI/i, /\bcodex\s+v?\d+\.\d+/i] },
];

// Paste/scrollback of documentation could contain these names far from any
// banner; only scan the head of the session where the banner lands.
function createAgentSniffer(onDetect) {
  let scanned = "";
  let detected = null;

  function feed(data) {
    if (detected) return detected;
    if (scanned.length >= MAX_SCAN_BYTES) return detected;
    // Strip ANSI so styled banners ("\x1b[1mClaude\x1b[0m Code") still match.
    scanned += String(data)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .slice(0, MAX_SCAN_BYTES - scanned.length);
    for (const { agent, patterns } of SIGNATURES) {
      if (patterns.some((pattern) => pattern.test(scanned))) {
        detected = agent;
        onDetect(agent);
        return detected;
      }
    }
    return detected;
  }

  return { feed, current: () => detected };
}

module.exports = { createAgentSniffer, MAX_SCAN_BYTES, SIGNATURES };
