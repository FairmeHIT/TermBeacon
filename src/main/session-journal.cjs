const fs = require("node:fs/promises");
const path = require("node:path");
const { sessionIdFitsAgent } = require("./session-resume.cjs");

const JOURNAL_VERSION = 1;
const MAX_ENTRIES = 512;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const AGENT_TYPES = new Set(["opencode", "codex", "claude", "pi"]);

function validTerminalId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

// Session ids arrive from a transient PTY message and used to wait for the
// renderer's 150 ms state save. A crash in that window lost the id and made the
// terminal unrecoverable, so the id is mirrored here immediately. One atomic
// fsync'd file is enough: writes are serialized and only happen when a
// terminal's CLI session changes.
function createSessionJournal({ file, now = Date.now } = {}) {
  if (typeof file !== "string" || !file) throw new Error("session journal requires a file path");
  let entries = new Map();
  let loadPromise;
  let tail = Promise.resolve();
  let tempSequence = 0;

  function prune(current = now()) {
    for (const [terminalId, entry] of entries) {
      if (!entry || current - entry.at > MAX_AGE_MS) entries.delete(terminalId);
    }
    if (entries.size <= MAX_ENTRIES) return;
    const ordered = [...entries.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    entries = new Map(ordered);
  }

  function serialize(operation) {
    const next = tail.catch(() => undefined).then(operation);
    tail = next.catch(() => undefined);
    return next;
  }

  async function persist() {
    const temp = `${file}.${process.pid}.${++tempSequence}.tmp`;
    const payload = JSON.stringify({ version: JOURNAL_VERSION, entries: Object.fromEntries(entries) });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(payload, "utf8");
      // The whole point is surviving a crash right after the message arrives.
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temp, file);
    } catch (error) {
      try { await fs.unlink(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  async function load() {
    if (!loadPromise) {
      loadPromise = (async () => {
        let parsed;
        try {
          parsed = JSON.parse(await fs.readFile(file, "utf8"));
        } catch (error) {
          if (error?.code !== "ENOENT") console.warn("[session-journal] ignoring unreadable journal", error?.message || error);
          prune();
          return Object.fromEntries(entries);
        }
        const source = parsed?.version === JOURNAL_VERSION && parsed.entries && typeof parsed.entries === "object"
          ? parsed.entries
          : {};
        for (const [terminalId, entry] of Object.entries(source)) {
          if (!validTerminalId(terminalId) || !entry || !AGENT_TYPES.has(entry.agentType)) continue;
          if (!sessionIdFitsAgent(entry.agentType, entry.sessionId)) continue;
          const at = Number(entry.at);
          if (!Number.isFinite(at) || at <= 0) continue;
          entries.set(terminalId, { sessionId: entry.sessionId, agentType: entry.agentType, at: Math.round(at) });
        }
        prune();
        return Object.fromEntries(entries);
      })();
    }
    return loadPromise;
  }

  function record({ terminalId, sessionId, agentType, at } = {}) {
    if (!validTerminalId(terminalId) || !AGENT_TYPES.has(agentType) || !sessionIdFitsAgent(agentType, sessionId)) {
      return Promise.resolve(false);
    }
    return serialize(async () => {
      await load();
      const previous = entries.get(terminalId);
      if (previous && previous.sessionId === sessionId && previous.agentType === agentType) return false;
      const stamp = Number.isFinite(at) && at > 0 ? Math.round(at) : now();
      entries.set(terminalId, { sessionId, agentType, at: stamp });
      prune();
      await persist();
      return true;
    });
  }

  // Startup repair uses this when the session store proves a persisted id
  // belongs to another terminal. Without removing the journal entry, the next
  // launch would copy the stale id back into state before the same repair runs
  // again.
  function forget(terminalId) {
    if (!validTerminalId(terminalId)) return Promise.resolve(false);
    return serialize(async () => {
      await load();
      if (!entries.delete(terminalId)) return false;
      await persist();
      return true;
    });
  }

  function flush() {
    return tail.catch(() => undefined);
  }

  return { load, record, forget, flush };
}

module.exports = { createSessionJournal, JOURNAL_VERSION, MAX_ENTRIES };
