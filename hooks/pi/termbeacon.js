import { createReporter } from "../shared/status-reporter.js";

// Pi 1.x extension. Outside TermBeacon no resources are allocated.
export default function termbeacon(pi) {
  const port = process.env.TERMBEACON_HOOK_PORT;
  const token = process.env.TERMBEACON_HOOK_TOKEN;
  const terminalId = process.env.TERMBEACON_TERMINAL_ID;
  if (!port || !token || !terminalId) return;
  let controller;
  let reporter;
  let busy = false;
  let failed = false;
  const start = () => {
    if (controller && !controller.signal.aborted) return;
    controller = new AbortController();
    reporter = createReporter({ port, token, terminalId }, controller.signal);
  };
  const report = (event, status, ctx) => {
    start();
    reporter.report(`pi.${event}`, status, ctx?.sessionManager?.getSessionId?.());
  };
  pi.on("session_start", () => { start(); busy = false; failed = false; });
  pi.on("agent_start", (_event, ctx) => { busy = true; failed = false; report("agent_start", "running", ctx); });
  pi.on("ui_prompt_start", (_event, ctx) => { if (busy) report("ui_prompt_start", "waiting", ctx); });
  pi.on("ui_prompt_end", (_event, ctx) => { if (busy) report("ui_prompt_end", "running", ctx); });
  pi.on("turn_end", (event) => { if (event.outcome === "error") failed = true; });
  // agent_end may be followed by retries, compaction or queued work.
  pi.on("agent_settled", (event, ctx) => {
    if (!busy) return;
    busy = false;
    report("agent_settled", failed && !event.aborted ? "failed" : "completed", ctx);
  });
  pi.on("session_shutdown", () => { controller?.abort(); busy = false; });
}
