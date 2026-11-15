/**
 * Automatic CLI agent identification from terminal output.
 *
 * The renderer used to make the user pick an agent type from a dropdown, which
 * exposed an internal detail: the detection engine's pattern set. Users just
 * type `claude` and expect the status light to work. This module sniffs the
 * first kilobytes of PTY output for each CLI's own banner/identity strings and
 * reports the agent type, so no manual selection is needed.
 *
 * Signatures are deliberately narrow because a wrong guess applies the wrong
 * completion patterns and makes the status light lie. Claude Code transcripts
 * routinely mention other CLIs by name ("go fully self-managed like opencode"),
 * so a bare product word is not evidence that the CLI is running. Only a banner
 * counts as proof; a shell echo of the launched command is a weaker hint that a
 * banner may later overrule.
 */

const MAX_SCAN_BYTES = 8 * 1024;

// Ordered most-specific first: `opencode` output can mention "claude" in
// prompts, and Claude Code mentions nothing about codex, but ordering removes
// any ambiguity when several signatures appear in one banner.
const SIGNATURES = [
  { agent: "pi", strength: "banner", patterns: [/\bpi coding agent\b/i, /\bpi\s+v?\d+\.\d+\.\d+\b/i] },
  { agent: "claude", strength: "banner", patterns: [/Claude Code/i, /✻\s*Welcome to Claude/i, /claude\.ai\/code/i] },
  { agent: "codex", strength: "banner", patterns: [/\bOpenAI Codex\b/i, /Codex CLI/i, /\bcodex\s+v?\d+\.\d+/i] },
  {
    agent: "opencode",
    strength: "command",
    patterns: [
      // A shell prompt followed by the command: `PS C:\work> opencode`.
      /(?:^|[\r\n])[^\r\n]{0,200}?[>$#%][ \t]*opencode(?:\.(?:cmd|exe|ps1))?(?=[ \t\r\n]|$)/i,
      // PowerShell's call operator, used by resume:
      // `> & 'C:\…\npm\opencode.cmd' '--standalone'`.
      /[>$#%][ \t]*&[ \t]*(?:'[^'\r\n]*[\\/])?opencode(?:\.(?:cmd|exe))?'?/i,
      // A bare command line (no prompt character, e.g. a captured fixture).
      /(?:^|[\r\n])[ \t]*opencode(?:\.(?:cmd|exe))?(?=[ \t\r\n]|$)/i,
      // Self-identifying version banner.
      /\bopencode\s+v?\d+\.\d+\.\d+\b/i,
    ],
  },
];

const STRENGTH_ORDER = ["banner", "command"];

function classify(text) {
  // Banner evidence always wins, regardless of signature order: an echoed
  // `opencode` command must not beat a real `Claude Code` banner in the same
  // scan window.
  for (const strength of STRENGTH_ORDER) {
    for (const signature of SIGNATURES) {
      if (signature.strength !== strength) continue;
      if (signature.patterns.some((pattern) => pattern.test(text))) return signature;
    }
  }
  return undefined;
}

// Paste/scrollback of documentation could contain these names far from any
// banner; only scan the head of the session where the banner lands.
function createAgentSniffer(onDetect) {
  let scanned = "";
  let detected = null;
  let locked = false;

  function feed(data) {
    if (locked) return detected;
    if (scanned.length >= MAX_SCAN_BYTES) return detected;
    // Strip ANSI so styled banners ("\x1b[1mClaude\x1b[0m Code") still match.
    scanned += String(data)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .slice(0, MAX_SCAN_BYTES - scanned.length);
    const match = classify(scanned);
    if (!match) return detected;
    if (match.agent !== detected) {
      detected = match.agent;
      onDetect(match.agent);
    }
    // A banner settles the identity; a command echo is only a hint and stays
    // open to correction while the CLI's own output is still in the window.
    if (match.strength === "banner") locked = true;
    return detected;
  }

  return { feed, current: () => detected };
}

module.exports = { createAgentSniffer, MAX_SCAN_BYTES, SIGNATURES };
