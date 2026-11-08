/**
 * Local hook bridge for CLI agents and agent plugins.
 *
 * The bridge listens on 127.0.0.1 on a random port. `pty-host` injects the
 * port, a per-process token and the terminal id into every PTY environment:
 *
 *   TERMBEACON_HOOK_PORT
 *   TERMBEACON_HOOK_TOKEN
 *   TERMBEACON_TERMINAL_ID
 *
 * A hook script or plugin POSTs JSON to http://127.0.0.1:<port>/hook with the
 * token in `x-termbeacon-token`:
 *
 *   { "terminalId": "...", "event": "session.status", "status": "completed" }
 *
 * Only loopback is bound and the token is required, so other local processes
 * cannot spoof agent state without reading the PTY environment.
 */
const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELD_LENGTH = 128;
const MAX_EVENT_LENGTH = 64;
const MAX_SESSION_ID_LENGTH = 256;

const STATUSES = new Set(["started", "running", "waiting", "completed", "failed"]);

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validPayload(payload) {
  return Boolean(payload)
    && typeof payload === "object"
    && typeof payload.terminalId === "string"
    && payload.terminalId.length > 0
    && payload.terminalId.length <= MAX_FIELD_LENGTH
    && typeof payload.event === "string"
    && payload.event.length > 0
    && payload.event.length <= MAX_EVENT_LENGTH
    && typeof payload.status === "string"
    && STATUSES.has(payload.status)
    && (payload.eventId === undefined || (typeof payload.eventId === "string" && payload.eventId.length > 0 && payload.eventId.length <= MAX_FIELD_LENGTH && !/[\u0000-\u001f\u007f]/.test(payload.eventId)))
    && (payload.occurredAt === undefined || (Number.isSafeInteger(payload.occurredAt) && payload.occurredAt >= 0))
    && (payload.sessionId === undefined || (typeof payload.sessionId === "string" && payload.sessionId.length > 0 && payload.sessionId.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(payload.sessionId)));
}

function createHookServer({ onEvent } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  let port = 0;
  let handler = onEvent;
  const delivered = new Map();

  const server = http.createServer((request, response) => {
    let pathname = "";
    try { pathname = new URL(request.url || "", "http://127.0.0.1").pathname; } catch { /* handled as not found */ }
    if (request.method !== "POST" || pathname !== "/hook") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!safeEqual(request.headers["x-termbeacon-token"] || "", token)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    let body = "";
    let bodyBytes = 0;
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > MAX_BODY_BYTES && !tooLarge) {
        tooLarge = true;
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "payload too large" }));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (!validPayload(payload)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid payload" }));
        return;
      }
      try {
        const key = payload.eventId ? JSON.stringify([payload.terminalId, payload.eventId]) : null;
        if (!key || !delivered.has(key)) {
          handler?.({ terminalId: payload.terminalId, event: payload.event, status: payload.status, sessionId: payload.sessionId, eventId: payload.eventId, occurredAt: payload.occurredAt, at: Date.now() });
          if (key) {
            delivered.set(key, true);
            if (delivered.size > 1024) delivered.delete(delivered.keys().next().value);
          }
        }
        response.writeHead(204);
        response.end();
      } catch {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "hook handler failed" }));
      }
    });
    request.on("error", () => {
      try { response.destroy(); } catch { /* already gone */ }
    });
  });

  function start(host = "127.0.0.1") {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        port = server.address().port;
        resolve(port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, host);
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    });
  }

  function setHandler(next) { handler = next; }

  return {
    start,
    close,
    setHandler,
    get port() { return port; },
    token,
  };
}

module.exports = { createHookServer, validPayload, STATUSES };
