const { randomUUID } = require("node:crypto");

const OUTPUT_HIGH_WATERMARK = 512 * 1024;
const OUTPUT_LOW_WATERMARK = 128 * 1024;

// One shared budget bounds all terminal writes awaiting xterm parsing. Replay
// uses the same path, so reconnecting many terminals cannot bypass the budget.
function createOutputFlow({ send, onPause, high = OUTPUT_HIGH_WATERMARK, low = OUTPUT_LOW_WATERMARK }) {
  let flowId = null;
  let nextId = 0;
  let pendingBytes = 0;
  let queuedBytes = 0;
  let queue = [];
  let head = 0;
  let blocked = false;
  let paused = false;
  let flushing = false;
  const pending = new Map();

  function pressure() {
    const bytes = pendingBytes + queuedBytes;
    const next = flowId !== null && (blocked || (paused ? bytes > low : bytes >= high));
    if (next !== paused) {
      paused = next;
      onPause(paused);
    }
  }

  function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (flowId && !blocked && pendingBytes < high && head < queue.length) {
        const entry = queue[head];
        if (pendingBytes > 0 && pendingBytes + entry.bytes > high) break;
        queue[head++] = null;
        queuedBytes -= entry.bytes;
        const deliveryId = ++nextId;
        pending.set(deliveryId, { terminalId: entry.message.terminalId, bytes: entry.bytes });
        pendingBytes += entry.bytes;
        if (send({ ...entry.message, flowId, deliveryId }) === false) blocked = true;
      }
      if (head === queue.length) {
        queue = [];
        head = 0;
      } else if (head > 64 && head * 2 >= queue.length) {
        queue = queue.slice(head);
        head = 0;
      }
    } finally {
      flushing = false;
      pressure();
    }
  }

  function detach() {
    flowId = null;
    pending.clear();
    pendingBytes = queuedBytes = 0;
    queue = [];
    head = 0;
    blocked = false;
    pressure();
  }

  function attach() {
    detach();
    flowId = randomUUID();
    return flowId;
  }

  function output(message) {
    if (!flowId) return;
    const bytes = Buffer.byteLength(message.data, "utf8");
    queue.push({ message, bytes });
    queuedBytes += bytes;
    flush();
  }

  function acknowledge(message) {
    if (message.flowId !== flowId || !Number.isSafeInteger(message.deliveryId)) return;
    const entry = pending.get(message.deliveryId);
    if (!entry) return;
    pending.delete(message.deliveryId);
    pendingBytes -= entry.bytes;
    flush();
  }

  function forget(terminalId) {
    queue = queue.slice(head).filter((entry) => {
      if (entry.message.terminalId !== terminalId) return true;
      queuedBytes -= entry.bytes;
      return false;
    });
    head = 0;
    for (const [id, entry] of pending) {
      if (entry.terminalId === terminalId) {
        pendingBytes -= entry.bytes;
        pending.delete(id);
      }
    }
    flush();
  }

  return { attach, detach, output, acknowledge, forget, drain() { blocked = false; flush(); }, get paused() { return paused; }, get flowId() { return flowId; } };
}

module.exports = { createOutputFlow, OUTPUT_HIGH_WATERMARK, OUTPUT_LOW_WATERMARK };
