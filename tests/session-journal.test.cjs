const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSessionJournal } = require("../src/main/session-journal.cjs");

function tempJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-journal-"));
  return { dir, file: path.join(dir, "session-journal.json") };
}

test("persists terminal session ids immediately and reloads them", async () => {
  const { dir, file } = tempJournal();
  try {
    const journal = createSessionJournal({ file, now: () => 1_800_000_000_000 });
    assert.equal(await journal.record({
      terminalId: "term-1",
      sessionId: "ses_abc0000000000000000000000",
      agentType: "opencode",
      at: 1_800_000_000_000,
    }), true);
    await journal.flush();
    const reopened = createSessionJournal({ file, now: () => 1_800_000_001_000 });
    const entries = await reopened.load();
    assert.deepEqual(entries["term-1"], {
      sessionId: "ses_abc0000000000000000000000",
      agentType: "opencode",
      at: 1_800_000_000_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same session id is not rewritten for every status event", async () => {
  const { dir, file } = tempJournal();
  try {
    const journal = createSessionJournal({ file });
    const entry = {
      terminalId: "term-1",
      sessionId: "ses_abc0000000000000000000000",
      agentType: "opencode",
      at: 1_800_000_000_000,
    };
    assert.equal(await journal.record(entry), true);
    assert.equal(await journal.record({ ...entry, at: entry.at + 10 }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects mismatched ids and recovers from a corrupt journal", async () => {
  const { dir, file } = tempJournal();
  try {
    fs.writeFileSync(file, "{not json");
    const journal = createSessionJournal({ file });
    assert.deepEqual(await journal.load(), {});
    assert.equal(await journal.record({
      terminalId: "term-1",
      sessionId: "not-an-opencode-id",
      agentType: "opencode",
    }), false);
    assert.equal(await journal.record({
      terminalId: "term-1",
      sessionId: "ses_abc0000000000000000000000",
      agentType: "codex",
    }), false);
    assert.equal(await journal.record({
      terminalId: "../escape",
      sessionId: "ses_abc0000000000000000000000",
      agentType: "opencode",
    }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
