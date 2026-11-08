const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHistoryStore, HISTORY_MAX_BYTES, HISTORY_TAIL_BYTES } = require("../src/main/terminal-history.cjs");
const { utf8Tail } = require("../src/main/utf8-utils.cjs");

test("UTF-8 tails preserve CJK and emoji at every possible byte boundary", () => {
  const text = "中文🙂abc".repeat(10);
  for (let bytes = 1; bytes < 50; bytes += 1) {
    const tail = utf8Tail(text, bytes);
    assert.ok(Buffer.byteLength(tail) <= bytes);
    assert.ok(text.endsWith(tail));
    assert.ok(!tail.includes("\uFFFD"));
  }
});

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termbeacon-history-test-"));
  const files = new Set();
  t.after(async () => { for (const file of files) await fs.unlink(file).catch(() => {}); await fs.rmdir(directory); });
  let rewrites = 0, bytesRead = 0;
  const store = createHistoryStore({ directory, fs: { ...fs,
    writeFile: async (...args) => { rewrites += 1; return fs.writeFile(...args); },
    open: async (...args) => {
      const handle = await fs.open(...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        read: async (...params) => { const result = await handle.read(...params); bytesRead += result.bytesRead; return result; },
      };
    },
  } });
  const target = (id) => { const file = path.join(directory, `${id}.log`); files.add(file); return file; };
  return { store, target, metrics: () => ({ rewrites, bytesRead }) };
}

test("CJK history trims below the byte limit once, then small appends avoid rewrites", async (t) => {
  const { store, target, metrics } = await harness(t);
  const file = target("cjk");
  await fs.writeFile(file, "中".repeat(250000), "utf8");
  for (let i = 0; i < 10; i += 1) await store.append("cjk", "中\n");
  assert.deepEqual(metrics(), { rewrites: 1, bytesRead: HISTORY_TAIL_BYTES });
  assert.ok((await fs.stat(file)).size <= HISTORY_MAX_BYTES);
  const text = await store.load("cjk");
  assert.ok(Buffer.byteLength(text) <= HISTORY_TAIL_BYTES);
  assert.ok(!text.includes("\uFFFD"));
  assert.ok(text.endsWith("中\n".repeat(10)));
});

test("large batches replace history with only their tail before disk writes", async (t) => {
  const { store, target, metrics } = await harness(t);
  const file = target("large");
  const text = "中🙂".repeat(300000);
  await store.append("large", text);
  assert.deepEqual(metrics(), { rewrites: 1, bytesRead: 0 });
  const saved = await fs.readFile(file, "utf8");
  assert.equal(saved, utf8Tail(text, HISTORY_TAIL_BYTES));
});

test("load reads only a bounded tail of legacy oversized logs", async (t) => {
  const { store, target, metrics } = await harness(t);
  await fs.writeFile(target("legacy"), "🙂".repeat(300000), "utf8");
  const text = await store.load("legacy");
  assert.equal(metrics().bytesRead, HISTORY_TAIL_BYTES);
  assert.ok(!text.includes("\uFFFD"));
});

test("append, load and remove serialize per terminal and reject invalid IDs", async (t) => {
  const { store, target } = await harness(t);
  target("ordered");
  const first = store.append("ordered", "one");
  const second = store.append("ordered", "two");
  const loaded = store.load("ordered");
  const removed = store.remove("ordered");
  await Promise.all([first, second, removed]);
  assert.equal(await loaded, "onetwo");
  assert.equal(await store.load("ordered"), "");
  assert.equal(await store.append("../escape", "bad"), true);
  assert.equal(await store.load("../escape"), "");
});
