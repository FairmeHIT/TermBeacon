const test = require("node:test");
const assert = require("node:assert");
const { createOscParser, sanitizeValue, decodeFileUri } = require("../src/main/osc-parser.cjs");

function recorder() {
  const events = { titles: [], cwds: [] };
  const parser = createOscParser(
    (title) => events.titles.push(title),
    (cwd) => events.cwds.push(cwd),
  );
  return { parser, events };
}

test("parses OSC 0 title terminated by BEL", () => {
  const { parser, events } = recorder();
  parser.feed("noise\x1b]0;Claude Code\x07more noise");
  assert.deepStrictEqual(events.titles, ["Claude Code"]);
});

test("parses OSC 2 title terminated by ESC backslash", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]2;npm test\x1b\\");
  assert.deepStrictEqual(events.titles, ["npm test"]);
});

test("sequence split across chunks still emits one title", () => {
  const { parser, events } = recorder();
  parser.feed("before \x1b]0;");
  assert.deepStrictEqual(events.titles, []);
  parser.feed("partial ti");
  assert.deepStrictEqual(events.titles, []);
  parser.feed("tle\x07 after");
  assert.deepStrictEqual(events.titles, ["partial title"]);
});

test("multiple sequences in one chunk all emit", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]0;one\x07\x1b]2;two\x1b\\\x1b]0;three\x07");
  assert.deepStrictEqual(events.titles, ["one", "two", "three"]);
});

test("OSC 7 file uri decodes to a cwd", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]7;file:///C:/Users/fairm/proj\x07");
  assert.deepStrictEqual(events.cwds, ["C:\\Users\\fairm\\proj"]);
});

test("OSC 7 with encoded spaces decodes", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]7;file:///home/user/my%20dir\x07");
  assert.deepStrictEqual(events.cwds, process.platform === "win32"
    ? ["\\home\\user\\my dir"]
    : ["/home/user/my dir"]);
});

test("other OSC codes are ignored", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]9;4;1;50\x07\x1b]8;;http://x\x1b\\");
  assert.deepStrictEqual(events.titles, []);
  assert.deepStrictEqual(events.cwds, []);
});

test("oversized unterminated sequence is abandoned, not buffered forever", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]0;" + "a".repeat(600));
  // No terminator: the parser gives up on the pending sequence and must not
  // carry a growing buffer into subsequent chunks.
  parser.feed("b".repeat(100));
  parser.feed("\x1b]0;ok\x07");
  assert.deepStrictEqual(events.titles, ["ok"]);
});

test("control characters and length are stripped from titles", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]0;\u0001 title \t with bells\x07");
  // Control chars (except the BEL terminator) are stripped; the value is trimmed.
  assert.deepStrictEqual(events.titles, ["title with bells"]);
});

test("empty title is not emitted", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]0;   \x07");
  assert.deepStrictEqual(events.titles, []);
});

test("sanitizeValue trims and caps length", () => {
  assert.strictEqual(sanitizeValue("  abc  "), "abc");
  assert.strictEqual(sanitizeValue("x".repeat(300)).length, 120);
  assert.strictEqual(sanitizeValue("bad\u001b[1m"), "bad[1m");
});

test("decodeFileUri handles posix and windows forms", () => {
  assert.strictEqual(decodeFileUri("file:///home/u", "linux"), "/home/u");
  assert.strictEqual(decodeFileUri("file:///D:/a b", "win32"), "D:\\a b");
  assert.strictEqual(decodeFileUri("http://x", "linux"), undefined);
  assert.strictEqual(decodeFileUri("file:///bad%ZZpath", "linux"), undefined);
});

test("OSC introducer and ST terminator can each be split after ESC", () => {
  const { parser, events } = recorder();
  assert.equal(parser.feed("before\x1b"), "before");
  assert.equal(parser.feed("]0;title\x1b"), "");
  assert.equal(parser.feed("\\after"), "after");
  assert.deepStrictEqual(events.titles, ["title"]);
});

test("discarded oversized OSC payload cannot leak completion text", () => {
  const { parser, events } = recorder();
  assert.equal(parser.feed("\x1b]52;" + "a".repeat(600)), "");
  assert.equal(parser.feed("Error: Done\x07visible"), "visible");
  parser.feed("\x1b]0;valid\x07");
  assert.deepStrictEqual(events.titles, ["valid"]);
});

test("a complete oversized sequence is also rejected", () => {
  const { parser, events } = recorder();
  parser.feed("\x1b]0;" + "a".repeat(600) + "\x07\x1b]0;valid\x07");
  assert.deepStrictEqual(events.titles, ["valid"]);
});
