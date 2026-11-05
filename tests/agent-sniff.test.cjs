const test = require("node:test");
const assert = require("node:assert");
const { createAgentSniffer, MAX_SCAN_BYTES } = require("../src/main/agent-sniff.cjs");

function makeSniffer() {
  const detected = [];
  const sniffer = createAgentSniffer((agent) => detected.push(agent));
  return { sniffer, detected };
}

test("detects Claude Code from its banner", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("\x1b[1m✻ Welcome to Claude Code\x1b[0m\r\n");
  assert.deepStrictEqual(detected, ["claude"]);
});

test("detects opencode", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("opencode v2.2.1\r\n");
  assert.deepStrictEqual(detected, ["opencode"]);
});

test("detects codex", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("OpenAI Codex v0.166.0\n");
  assert.deepStrictEqual(detected, ["codex"]);
});

test("ignores a plain shell prompt", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("Microsoft Windows [版本 10.0.26200.9711]\r\n(c) Microsoft Corporation。\r\nC:\\>");
  assert.deepStrictEqual(detected, []);
});

test("matches across chunk boundaries", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("✻ Welcome to Cla");
  assert.deepStrictEqual(detected, []);
  sniffer.feed("ude Code\r\n");
  assert.deepStrictEqual(detected, ["claude"]);
});

test("strips ANSI styling before matching", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("\x1b[32mClaude\x1b[0m \x1b[32mCode\x1b[0m");
  assert.deepStrictEqual(detected, ["claude"]);
});

test("reports each agent only once", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("Claude Code\n");
  sniffer.feed("Claude Code again\n");
  sniffer.feed("opencode\n");
  assert.deepStrictEqual(detected, ["claude"]);
});

test("stops scanning after the head of the session", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("x".repeat(MAX_SCAN_BYTES));
  sniffer.feed("Claude Code\n");
  assert.deepStrictEqual(detected, []);
});
