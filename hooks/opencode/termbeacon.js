/**
 * TermBeacon plugin for opencode.
 *
 * V2 plugin API: the default export is a definition with an `id` and a
 * `setup(ctx)` function. V1 plugins (a function returning an `event` hook)
 * no longer run in opencode V2.
 *
 * opencode loads plugins from ~/.config/opencode/plugins/ (global) or
 * .opencode/plugins/ (project). TermBeacon injects TERMBEACON_HOOK_PORT,
 * TERMBEACON_HOOK_TOKEN and TERMBEACON_TERMINAL_ID into the CLI environment.
 * Outside TermBeacon the environment is absent and the plugin is a no-op.
 *
 * Install: copy this file to ~/.config/opencode/plugins/termbeacon/index.js, then
 * restart opencode (or run `opencode reload`).
 *
 * opencode 2.3 compatibility (verified against a live 2.3.0 instance):
 * - events now carry `data.sessionID` (they were bare in 2.2.x), so session
 *   attribution finally works;
 * - `ctx.session.active()` was removed, so the old snapshot repair is dead on
 *   2.3. The replacement reads `time.busy` / `time.idle` / `outcome` from
 *   `ctx.session.get()`, which is enough to repair both a missed start and a
 *   missed terminal event;
 * - `question.*` events no longer exist; questions are delivered as
 *   `permission.asked` with kind=question and handled by the existing
 *   permission branch;
 * - envelopes carry `location.directory` and one server can observe sessions
 *   from several directories, so foreign-directory events are dropped.
 */

import { createReporter } from "../shared/status-reporter.js";
export { createReporter } from "../shared/status-reporter.js";
import { setTimeout as delay } from "node:timers/promises";

const STATUS = {
  busy: "running",
  running: "running",
  retry: "running",
  idle: "completed",
  completed: "completed",
  succeeded: "completed",
  interrupted: "completed",
  cancelled: "completed",
  error: "failed",
  failed: "failed",
};

/** Events worth forwarding; anything else is ignored. */
const EVENT_TYPES = [
  "session.status",
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  // opencode 2.2.x only; 2.3 delivers questions through permission.asked.
  "question.asked",
  "question.replied",
  "question.rejected",
];

function bridge() {
  const port = process.env.TERMBEACON_HOOK_PORT;
  const token = process.env.TERMBEACON_HOOK_TOKEN;
  const terminalId = process.env.TERMBEACON_TERMINAL_ID;
  if (!port || !token || !terminalId) return null;
  return { port, token, terminalId };
}

function statusOf(value) {
  if (!value) return undefined;
  if (typeof value === "string") return STATUS[value.toLowerCase()];
  const type = value.type || value.status || value.state || value.outcome;
  return typeof type === "string" ? STATUS[type.toLowerCase()] : undefined;
}

function sessionIdOf(event) {
  const data = event && event.data;
  const candidates = [
    data?.sessionId, data?.session_id, data?.sessionID,
    data?.session?.id, data?.session?.sessionId,
    event?.sessionId, event?.session_id, event?.sessionID,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return value && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, 256) : undefined;
}

function sessionInfo(response) {
  const data = response?.data || response;
  return data?.info || data;
}

function eventDirectory(event) {
  const directory = event?.location?.directory;
  return typeof directory === "string" && directory.trim() ? directory : undefined;
}

// The opencode server can serve several project directories at once (parent
// chains, worktrees), and its event stream is server-wide. Events about a
// directory that is not this terminal's project belong to another terminal.
function createLocationFilter() {
  let own;
  try { own = process.cwd(); } catch { own = undefined; }
  if (!own) return () => true;
  const normalize = (value) => value.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  const ownNorm = normalize(own);
  return (event) => {
    const directory = eventDirectory(event);
    if (!directory) return true; // pre-2.3 envelopes carry no location.
    const other = normalize(directory);
    // Exact match, or a parent/child of the working directory: opencode may
    // boot from a worktree root while the session lives in a subdirectory.
    return other === ownNorm
      || other.startsWith(`${ownNorm}\\`) || ownNorm.startsWith(`${other}\\`);
  };
}

async function boundedRead(operation, signal) {
  let timer;
  let abort;
  const deadline = new Promise((_, reject) => {
    abort = () => reject(new Error("TermBeacon read cancelled"));
    timer = setTimeout(abort, 1500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}


export default {
  id: "termbeacon",
  async setup(ctx) {
    const connection = bridge();
    // Not launched by TermBeacon: stay inert.
    if (!connection) return;

    const controller = new AbortController();
    const registrations = [];
    const reporter = createReporter({ ...connection, agent: "opencode" }, controller.signal);
    const parents = new Map();
    const locationFits = createLocationFilter();
    let activeSessionId;
    let hasTurn = false;
    let turnStartedAt = 0;
    let revision = 0;
    let processing = Promise.resolve();

    async function report(event, status, sessionId, select, occurredAt) {
      if (!status || controller.signal.aborted) return;
      if (!hasTurn && (status === "completed" || status === "failed")) return;
      if (sessionId) {
        if (!parents.has(sessionId) && typeof ctx.session?.get === "function") {
          try {
            const session = await boundedRead(() => ctx.session.get({ sessionID: sessionId }), controller.signal);
            const info = sessionInfo(session);
            if (info) {
              parents.set(sessionId, info.parentID || info.parentId || null);
              if (parents.size > 256) parents.delete(parents.keys().next().value);
            }
          } catch { /* Retry metadata lookup on the next event. */ }
        }
        // Child execution/idle/failure is not the main turn's lifecycle.
        const parent = parents.get(sessionId);
        if (parent) {
          // A child's permission/question can still require human input for
          // the active root. Only its lifecycle completion is irrelevant.
          if (parent !== activeSessionId || !/^(permission|question)\./.test(event)) return;
          sessionId = activeSessionId;
        }
        if (select || !activeSessionId) activeSessionId = sessionId;
        if (activeSessionId !== sessionId) return;
      }
      if (controller.signal.aborted) return;
      if (status === "running" && (select || !hasTurn || ["completed", "failed"].includes(reporter.latest?.status))) turnStartedAt = occurredAt;
      hasTurn = true;
      reporter.report(event, status, sessionId || activeSessionId, occurredAt);
    }

    function enqueue(event, status, sessionId, select = false) {
      const occurredAt = Date.now();
      revision += 1;
      processing = processing.then(() => report(event, status, sessionId, select, occurredAt)).catch(() => {});
      return processing;
    }

    // Public read-only APIs repair a missed terminal event after reconnect.
    // Never let a slow snapshot overwrite an event received while it loaded.
    let refreshing = false;
    async function reconcile() {
      if (refreshing || !activeSessionId || controller.signal.aborted
        || typeof ctx.session?.get !== "function") return;
      refreshing = true;
      const selected = activeSessionId;
      const before = revision;
      try {
        if (typeof ctx.session.active === "function") {
          // opencode <= 2.2: `active()` lists the foreground sessions.
          const [session, active] = await boundedRead(() => Promise.all([
            ctx.session.get({ sessionID: selected }), ctx.session.active(),
          ]), controller.signal);
          if (controller.signal.aborted || selected !== activeSessionId || before !== revision) return;
          const info = sessionInfo(session);
          const activeData = active?.data || active;
          const isActive = Array.isArray(activeData)
            ? activeData.some((item) => (typeof item === "string" ? item : item?.id || item?.sessionID) === selected)
            : activeData && Object.prototype.hasOwnProperty.call(activeData, selected);
          // outcome survives between turns. An old idle projection must not end
          // a newly submitted prompt while admission is still in progress.
          if (!isActive && Number.isFinite(info?.time?.idle) && info.time.idle < turnStartedAt) return;
          // `session.active()` describes the foreground session owned by the
          // OpenCode process, not whether its latest turn is still running. The
          // interactive TUI keeps a completed session in that list while it
          // waits for the next prompt. Once a native completion/failure was
          // delivered, treating that stale membership as `running` would
          // relight the detector and make a finished task survive reconnects as
          // Working. A new prompt/execution event updates `reporter.latest` and
          // is the authoritative signal that a new turn has started.
          const latestStatus = reporter.latest?.status;
          // A session's `outcome` field persists across turns. Re-reporting a
          // stale `failed`/`error` outcome from a previous turn would overwrite
          // a newer `completed` delivered by the event stream (e.g. a successful
          // retry after a transient tool failure), leaving the sidebar stuck on
          // the error lamp even though the task finished normally. Only let a
          // snapshot repair a missing terminal state, never downgrade a known one.
          const status = isActive
            ? latestStatus === "waiting" ? "waiting"
              : latestStatus === "completed" || latestStatus === "failed" ? undefined
                : "running"
            : (latestStatus === "completed" || latestStatus === "failed"
              ? undefined : statusOf(info?.outcome));
          if (status) reporter.report("session.snapshot", status, selected);
          return;
        }
        // opencode 2.3: `active()` is gone. `time.busy` advances when a turn
        // starts and `time.idle` when it ends, so together with `outcome`
        // they describe the tracked session exactly, without needing the
        // foreground list.
        const session = await boundedRead(() => ctx.session.get({ sessionID: selected }), controller.signal);
        if (controller.signal.aborted || selected !== activeSessionId || before !== revision) return;
        const info = sessionInfo(session);
        const busy = Number.isFinite(info?.time?.busy) ? info.time.busy : 0;
        const idle = Number.isFinite(info?.time?.idle) ? info.time.idle : 0;
        const latestStatus = reporter.latest?.status;
        if (busy > 0 && idle >= busy && idle >= turnStartedAt) {
          // The turn that started at `busy` has ended at `idle`; `outcome`
          // records how it ended. Only repair a state we never heard about
          // and never downgrade a completion/failure the stream delivered.
          if (latestStatus === "running" || latestStatus === "waiting") {
            reporter.report("session.snapshot", statusOf(info?.outcome) || "completed", selected);
          }
        } else if (busy > turnStartedAt) {
          // A turn newer than everything we reported is in flight (busy
          // without a matching idle): the stream missed its start.
          if (latestStatus !== "running" && latestStatus !== "waiting") {
            reporter.report("session.snapshot", "running", selected);
          }
        }
      } catch { /* The next poll/reconnect retries the snapshot. */ }
      finally { refreshing = false; }
    }

    const poll = setInterval(() => { void reconcile(); }, 5000);
    poll.unref?.();

    // Primary signal: the public event stream. The envelope is
    // { id, created, type, location, data }.
    void (async () => {
      let backoff = 500;
      while (!controller.signal.aborted && typeof ctx.event?.subscribe === "function") {
        try {
          for await (const event of ctx.event.subscribe({
            types: EVENT_TYPES,
            signal: controller.signal,
          })) {
            const type = event && event.type;
            const data = (event && event.data) || {};
            // A standalone server can still observe other directories
            // (worktrees, parent chains); their sessions are not ours.
            if (!locationFits(event)) continue;
            const sessionId = sessionIdOf(event);
            if (type === "session.status") {
              await enqueue(type, statusOf(data.status), sessionId);
            } else if (type === "session.idle") {
              await enqueue(type, statusOf(data.outcome) || statusOf(data?.info?.outcome) || "completed", sessionId);
            } else if (type === "session.execution.started") {
              await enqueue(type, "running", sessionId);
            } else if (
              type === "session.execution.succeeded" ||
              type === "session.execution.interrupted"
            ) {
              await enqueue(type, "completed", sessionId);
            } else if (type === "session.execution.failed") {
              await enqueue(type, "failed", sessionId);
            } else if (type === "permission.asked" || type === "question.asked") {
              await enqueue(type, "waiting", sessionId);
            } else if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") {
              await enqueue(type, "running", sessionId);
            }
            backoff = 500;
          }
        } catch {
          // A stream can overflow/disconnect; resubscribe with bounded backoff.
        }
        if (controller.signal.aborted) break;
        try { await delay(backoff, undefined, { signal: controller.signal }); } catch { break; }
        await reconcile();
        backoff = Math.min(backoff * 2, 5000);
      }
    })();

    // Fallback signals that do not depend on the public stream: a submitted
    // prompt or a tool call always means the session is working.
    try {
      registrations.push(
        await ctx.session.hook("prompt", (event) => { void enqueue("session.prompt", "running", sessionIdOf(event), true); }),
      );
    } catch {
      // Older builds may not expose this hook.
    }
    try {
      registrations.push(
        await ctx.tool.hook("execute.before", (event) => { void enqueue("tool.execute.before", "running", sessionIdOf(event)); }),
      );
    } catch {
      // Ignore.
    }

    return () => {
      controller.abort();
      clearInterval(poll);
      for (const registration of registrations) {
        try {
          void Promise.resolve(registration.dispose()).catch(() => {});
        } catch {
          // Ignore.
        }
      }
    };
  },
};
