import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

async function post(connection, payload, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 1000);
  try {
    const response = await fetch(`http://127.0.0.1:${connection.port}/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-termbeacon-token": connection.token,
      },
      body: JSON.stringify({ terminalId: connection.terminalId, ...payload }),
      signal: controller.signal,
    });
    return response.ok ? "ok" : response.status >= 500 || response.status === 408 || response.status === 429 ? "retry" : "reject";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

// Serialize delivery so a slow running event cannot arrive after completion.
// Keep memory bounded and retry the latest state when the bridge recovers.
export function createReporter(connection, signal) {
  let queue = [];
  let sending = false;
  let latest;

  async function flush() {
    if (sending) return;
    sending = true;
    let backoff = 250;
    try {
      while (queue.length && !signal.aborted) {
        const payload = queue[0];
        const result = await post(connection, payload, signal);
        if (result !== "retry") {
          queue.shift();
          backoff = 250;
          continue;
        }
        // Intermediate transitions are obsolete once a newer state exists.
        queue = queue.slice(-1);
        await delay(backoff, undefined, { signal });
        queue = queue.slice(-1);
        backoff = Math.min(backoff * 2, 5000);
      }
    } catch {
      // Cleanup aborts both pending HTTP and retry timers.
    } finally { sending = false; }
  }

  function report(event, status, sessionId, occurredAt = Date.now()) {
    if (!status || signal.aborted) return;
    if (latest && latest.status === status && latest.sessionId === sessionId
      && occurredAt - latest.occurredAt < 1000) return;
    latest = { event, status, sessionId, occurredAt, eventId: randomUUID() };
    queue.push(latest);
    if (queue.length > 64) queue.splice(1, queue.length - 64);
    void flush();
  }

  return { report, get latest() { return latest; } };
}
