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

test("detects opencode from the echoed launch command", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("PS D:\\work\\app> opencode\r\n");
  assert.deepStrictEqual(detected, ["opencode"]);
});

test("detects opencode from a PowerShell resume command", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("PS D:\\work\\app> & 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd' '--standalone' '--session' 'ses_abc'\r\n");
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

test("a transcript mentioning opencode is not an opencode launch", () => {
  // Regression: Claude Code printed "…want to go fully self-managed like
  // opencode" while working in this repo, and the terminal was relabelled
  // `opencode` even though it only ever ran Claude.
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("I should go fully self-managed like opencode, keeping the claude models.\r\n");
  sniffer.feed("> 后期不想用 cc-switch 了，类似 opencode 自管\r\n");
  assert.deepStrictEqual(detected, []);
});

test("a real banner overrules an earlier command-level guess", () => {
  const { sniffer, detected } = makeSniffer();
  sniffer.feed("PS D:\\work\\app> opencode\r\n");
  assert.deepStrictEqual(detected, ["opencode"]);
  sniffer.feed("✻ Welcome to Claude Code v2.1\r\n");
  assert.deepStrictEqual(detected, ["opencode", "claude"]);
  // The banner settles the identity: later mentions change nothing.
  sniffer.feed("PS D:\\work\\app> opencode\r\n");
  assert.deepStrictEqual(detected, ["opencode", "claude"]);
});
