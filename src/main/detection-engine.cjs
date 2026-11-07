const registry = require("./agent-registry.cjs");

function stripAnsi(value) {
  return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

// Terminal input includes CSI/OSC/SS3 sequences for arrow keys, mouse reports
// and bracketed paste. Their payload bytes are printable ASCII, so checking the
// raw string would arm a task just because the user pressed an arrow key.
function stripInputSequences(value) {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001bO[\x20-\x7e]/g, "")
    .replace(/\u001b[PX^_][^\u001b]*(?:\u001b\\)/g, "")
    .replace(/\u001b[@-_]/g, "");
}

function parseOscProgress(value) {
  const match = value.match(/\u001b\]9;4;(\d+);?(\d+)?(?:\u0007|\u001b\\)/);
  if (!match) return undefined;
  return { state: Number(match[1]), progress: match[2] === undefined ? undefined : Number(match[2]) };
}

// Claude Code and Codex report activity through the terminal title: a spinner
// glyph while working, a static title when idle. This survives TUI redraws that
// never place a prompt at the end of a PTY chunk.
function parseOscTitle(value) {
  const match = value.match(/\u001b\][02];([^\u0007\u001b]*)(?:\u0007|\u001b\\)/);
  return match ? match[1] : undefined;
}

// Evidence is deliberately short-lived: a prompt or "Done" from earlier output
// must not keep matching on every later chunk.
const EVIDENCE_TAIL = 1024;
const SIGNAL_TAIL = 512;
const COMPLETION_LINES = 2;

function tailLines(text, count) {
  const lines = text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .filter((line) => line.length > 0);
  return lines.slice(-count).join("\n");
}

function createDetector(agentType = "generic", emit = () => {}) {
  const config = registry[agentType] || registry.generic;
  const runtime = {
    state: "ready",
    armed: false,
    toolInFlight: false,
    toolStartedAt: 0,
    lastOutputAt: 0,
    candidateAt: 0,
    signalTail: "",
    oscProgress: undefined,
    oscCompletedAt: 0,
    title: "",
    titleWorkingAt: 0,
    titleIdleAt: 0,
    pending: null,
  };
  // Longer quiet window required when OSC 9;4 progress-100 is the only
  // completion evidence, no prompt/completion text has been observed.
  const oscOnlyConfirmMs = (config.quietWindow.confirmMs || 2500) * 3;
  const oscOnlyConfidence = 0.6;

  function transition(current, confidence, source, summary) {
    if (runtime.state === current) return;
    const previous = runtime.state;
    runtime.state = current;
    emit({ previous, current, confidence, source, summary, at: Date.now() });
  }

  function resetTask() {
    runtime.armed = false;
    runtime.toolInFlight = false;
    runtime.toolStartedAt = 0;
    runtime.pending = null;
    runtime.candidateAt = 0;
    runtime.signalTail = "";
    runtime.oscProgress = undefined;
    runtime.oscCompletedAt = 0;
    runtime.titleWorkingAt = 0;
    runtime.titleIdleAt = 0;
  }

  function input(data) {
    const printable = stripInputSequences(data);
    if (/[^\u0000-\u001f\u007f]/.test(printable)) {
      resetTask();
      runtime.armed = true;
      transition("working", 0.55, "user");
    }
  }

  // Starting a CLI is not a task. The launch path writes the agent command to
  // the PTY but keeps the detector disarmed, so the CLI banner and its initial
  // prompt settle as "ready" instead of lighting "completed-unseen".
  function launch() {
    resetTask();
    transition("ready", 1, "user");
  }

  function output(data, now = Date.now()) {
    const clean = stripAnsi(data);
    const osc = parseOscProgress(data);
    if (osc) {
      runtime.oscProgress = osc;
      // OSC 9;4 state 0 removes the progress line (task finished or reset);
      // progress 100 with any active state also marks completion evidence.
      if (osc.progress >= 100 && osc.state !== 0) runtime.oscCompletedAt = now;
      if (osc.state === 0) runtime.oscCompletedAt = now;
    }
    const title = parseOscTitle(data);
    if (title !== undefined) {
      runtime.title = title;
      const titleConfig = config.title;
      const titleWorking = titleConfig?.working?.some((pattern) => pattern.test(title)) ?? false;
      const titleIdle = titleConfig?.idle?.some((pattern) => pattern.test(title)) ?? false;
      if (titleWorking) {
        runtime.titleWorkingAt = now;
        runtime.titleIdleAt = 0;
        if (runtime.armed && runtime.state !== "error") {
          transition("working", 0.85, "title", title);
        }
      } else if (titleIdle) {
        runtime.titleIdleAt = now;
        if (!runtime.armed && runtime.state === "working") {
          transition("ready", 0.8, "title", title);
        }
      }
    }
    const recent = (runtime.signalTail + clean).slice(-EVIDENCE_TAIL);
    runtime.signalTail = recent.slice(-SIGNAL_TAIL);
    runtime.lastOutputAt = now;
    const evidence = tailLines(recent, COMPLETION_LINES);
    const dialog = tailLines(recent, 8);
    const errorLines = tailLines(recent, 4);
    const lastLine = tailLines(recent, 1);
    const hasWorkingSignal = config.patterns.working.some((pattern) => pattern.test(clean));

    if (config.patterns.waitingInput.some((pattern) => pattern.test(dialog))) {
      runtime.pending = null;
      transition("awaiting-input", 0.78, "output", clean.trim().slice(-160));
      return;
    }
    if (config.patterns.error.some((pattern) => pattern.test(errorLines))) {
      // OpenCode can render a provider/tool failure while immediately retrying
      // the same turn. Keep the sidebar aligned with the still-active TUI when
      // the same chunk carries an unambiguous working signal.
      if (config.id === "opencode" && hasWorkingSignal) {
        runtime.armed = true;
        runtime.pending = null;
        transition("working", 0.65, "output", clean.trim().slice(-160));
      } else {
        runtime.pending = null;
        transition("error", 0.7, "output", clean.trim().slice(-160));
        return;
      }
    }
    if (config.patterns.toolStart.some((pattern) => pattern.test(clean))) {
      runtime.armed = true;
      runtime.toolInFlight = true;
      runtime.toolStartedAt = now;
    }
    if (config.patterns.toolEnd.some((pattern) => pattern.test(clean))) {
      runtime.toolInFlight = false;
      runtime.toolStartedAt = 0;
    }
    if (runtime.armed && (runtime.state !== "error" || (config.id === "opencode" && hasWorkingSignal))) {
      transition("working", 0.6, "output", clean.trim().slice(-160));
    }
    const promptChunk = clean.trim();
    const hasPrompt = config.patterns.prompt.some((pattern) => pattern.test(lastLine))
      || (promptChunk.length > 0 && promptChunk.length <= 8
        && config.patterns.prompt.some((pattern) => pattern.test(promptChunk)));
    const hasCompletion = config.patterns.completion.some((pattern) => pattern.test(evidence));
    if (runtime.armed && (hasPrompt || hasCompletion)) {
      runtime.candidateAt = now;
      runtime.pending = {
        summary: clean.trim().slice(-160) || runtime.signalTail.trim().slice(-160),
        source: hasCompletion ? "completion" : runtime.oscCompletedAt ? "osc+prompt" : "prompt",
      };
    } else if (clean.trim()) {
      // Substantive output after a candidate means the agent is still active;
      // an older prompt/complete marker must not confirm by itself later.
      runtime.pending = null;
      runtime.candidateAt = 0;
    }
  }

  function tick(now = Date.now()) {
    if (runtime.armed && runtime.titleIdleAt && runtime.titleWorkingAt && runtime.state === "working") {
      const quietFor = now - runtime.lastOutputAt;
      const idleFor = now - runtime.titleIdleAt;
      const toolGraceElapsed = !runtime.toolInFlight
        || quietFor >= config.quietWindow.maxToolGraceMs;
      if (toolGraceElapsed && quietFor >= config.quietWindow.candidateMs && idleFor >= config.quietWindow.confirmMs) {
        transition("completed-unseen", 0.9, "title", runtime.title || "title idle");
        runtime.pending = null;
        runtime.armed = false;
        runtime.titleIdleAt = 0;
        runtime.titleWorkingAt = 0;
        runtime.signalTail = "";
        runtime.oscProgress = undefined;
        runtime.oscCompletedAt = 0;
        return;
      }
    }
    if (!runtime.pending) {
      // OSC-only completion path: progress reached 100 (or state 0) but no
      // prompt/completion text ever arrived. Require the longer quiet window
      // and settle at lower confidence so text evidence always dominates.
      if (!runtime.oscCompletedAt || !runtime.armed) return;
      const quietFor = now - runtime.lastOutputAt;
      const oscFor = now - runtime.oscCompletedAt;
      if (runtime.toolInFlight && quietFor < config.quietWindow.maxToolGraceMs) return;
      if (quietFor >= config.quietWindow.candidateMs && oscFor >= oscOnlyConfirmMs) {
        transition("completed-unseen", oscOnlyConfidence, "osc", "progress complete (osc only)");
        runtime.armed = false;
        runtime.signalTail = "";
        runtime.oscProgress = undefined;
        runtime.oscCompletedAt = 0;
      }
      return;
    }
    const quietFor = now - runtime.lastOutputAt;
    const candidateFor = now - runtime.candidateAt;
    const toolGraceElapsed = !runtime.toolInFlight
      || quietFor >= config.quietWindow.maxToolGraceMs;
    if (!toolGraceElapsed) return;
    const confirmMs = runtime.oscCompletedAt
      ? Math.max(config.quietWindow.candidateMs, config.quietWindow.confirmMs / 2)
      : config.quietWindow.confirmMs;
    if (quietFor >= config.quietWindow.candidateMs && candidateFor >= confirmMs) {
      const confidence = runtime.oscCompletedAt ? 0.88 : 0.82;
      transition("completed-unseen", confidence, "output", runtime.pending.summary);
      runtime.pending = null;
      runtime.armed = false;
      runtime.signalTail = "";
      runtime.oscProgress = undefined;
      runtime.oscCompletedAt = 0;
    }
  }

  function viewed() {
    if (runtime.state === "completed-unseen") transition("ready", 1, "user");
  }

  function exit(exitCode) {
    transition(exitCode === 0 ? "stopped" : "error", 1, "process");
  }

  function hook(event, status) {
    if (status === "started" || status === "running") {
      runtime.armed = true;
      transition("working", 0.9, "hook");
    } else if (status === "waiting") {
      transition("awaiting-input", 0.9, "hook");
    } else if (status === "completed") {
      runtime.pending = { summary: event, source: "hook" };
      runtime.candidateAt = Date.now();
      runtime.lastOutputAt = Date.now();
      tick(runtime.candidateAt + config.quietWindow.confirmMs);
    } else if (status === "failed") {
      transition("error", 0.95, "hook", event);
    }
  }

  return { runtime, input, launch, output, tick, viewed, exit, hook, config };
}

module.exports = { createDetector, stripAnsi, stripInputSequences, parseOscProgress, parseOscTitle };
