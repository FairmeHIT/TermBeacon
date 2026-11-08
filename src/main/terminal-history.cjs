const path = require("node:path");
const { utf8Tail } = require("./utf8-utils.cjs");

const HISTORY_MAX_BYTES = 400_000;
const HISTORY_TAIL_BYTES = 250_000;

function createHistoryStore({ directory, fs = require("node:fs/promises") }) {
  const writes = new Map();
  let directoryReady;

  function historyPath(terminalId) {
    return typeof terminalId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(terminalId)
      ? path.join(directory, `${terminalId}.log`)
      : null;
  }

  async function readTail(target) {
    const handle = await fs.open(target, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - HISTORY_TAIL_BYTES);
      const bytes = Buffer.alloc(Math.min(size, HISTORY_TAIL_BYTES));
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      // A seek can land inside a multibyte character.
      let offset = 0;
      if (start > 0) while (offset < read && (bytes[offset] & 0xc0) === 0x80) offset += 1;
      return bytes.subarray(offset, read).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  function serialize(terminalId, operation) {
    const next = (writes.get(terminalId) || Promise.resolve()).catch(() => undefined).then(operation);
    writes.set(terminalId, next);
    const cleanup = () => { if (writes.get(terminalId) === next) writes.delete(terminalId); };
    void next.then(cleanup, cleanup);
    return next;
  }

  async function load(terminalId) {
    const target = historyPath(terminalId);
    if (!target) return "";
    return serialize(terminalId, async () => {
      try { return await readTail(target); } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
      }
    });
  }

  function append(terminalId, data) {
    const target = historyPath(terminalId);
    if (!target || typeof data !== "string" || data.length === 0) return Promise.resolve(true);
    // Bound queued writes too: one busy terminal must not retain entire log bursts.
    const bytes = Buffer.byteLength(data, "utf8");
    const tail = bytes >= HISTORY_TAIL_BYTES ? utf8Tail(data, HISTORY_TAIL_BYTES) : data;
    return serialize(terminalId, async () => {
      if (!directoryReady) directoryReady = fs.mkdir(directory, { recursive: true }).catch((error) => {
        directoryReady = undefined;
        throw error;
      });
      await directoryReady;
      if (bytes >= HISTORY_TAIL_BYTES) {
        await fs.writeFile(target, tail, "utf8");
      } else {
        await fs.appendFile(target, tail, "utf8");
        if ((await fs.stat(target)).size > HISTORY_MAX_BYTES) {
          await fs.writeFile(target, await readTail(target), "utf8");
        }
      }
      return true;
    });
  }

  function remove(terminalId) {
    const target = historyPath(terminalId);
    if (!target) return Promise.resolve(true);
    return serialize(terminalId, async () => {
      try { await fs.unlink(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
      return true;
    });
  }

  return { load, append, remove };
}

module.exports = { createHistoryStore, HISTORY_MAX_BYTES, HISTORY_TAIL_BYTES };
