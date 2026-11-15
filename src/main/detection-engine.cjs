const registry = require("./agent-registry.cjs");
const { createOscParser } = require("./osc-parser.cjs");

function stripAnsi(value) {
  // Most shell/build output carries no escape sequences at all. Skipping the
  // regex keeps the common case allocation-free instead of scanning every
  // chunk with the full ANSI grammar.
  if (!value.includes("\u001b") && !value.includes("\u009b")) return value;
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
// Detection only needs the newest lines. Capping the scan window keeps a large
// PTY burst (a build log or `cat` of a big file) from re-running every pattern
// over megabytes of text while preserving the state the sidebar shows.
const MAX_DETECTION_CHARS = 8192;

// Collect the last `count` non-empty lines without splitting the whole input.
// tailLines used to allocate one array per requested line count; the output
// path asks for four different counts per PTY chunk.
function lastLines(text, count) {
  const lines = [];
  let end = text.length;
  while (end > 0 && lines.length < count) {
    let start = end - 1;
    while (start >= 0) {
      const code = text.charCodeAt(start);
      if (code === 10 || code === 13) break;
      start -= 1;
    }
    const line = text.slice(start + 1, end).replace(/[ \t]+$/, "");
    if (line.length > 0) lines.push(line);
    end = start;
  }
  lines.reverse();
  return lines;
}

function tailLines(text, count) {
  return lastLines(text, count).join("\n");
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
    hookStatus: null,
    hookOccurredAt: 0,
  };
  let outputAt = 0;
  const oscParser = createOscParser(title, undefined, progress);
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
    runtime.hookStatus = null;
  }

  function input(data) {
    const printable = stripInputSequences(data);
    // Editing a prompt is not a new native turn. In particular, typing a
    // permission answer must not release the hook's waiting state early.
    if (runtime.hookStatus && !/[\r\n]/.test(printable)) return;
    if (/[^\u0000-\u001f\u007f]/.test(printable)
      || ((runtime.hookStatus || runtime.state === "awaiting-input") && /[\r\n]/.test(printable))) {
      resetTask();
      runtime.hookOccurredAt = Math.max(runtime.hookOccurredAt, Date.now());
      runtime.armed = true;
      transition("working", 0.55, "user");
    }
  }

  // Starting a CLI is not a task. The launch path writes the agent command to
  // the PTY but keeps the detector disarmed, so the CLI banner and its initial
  // prompt settle as "ready" instead of lighting "completed-unseen".
  function launch() {
    resetTask();
    oscParser.reset();
    transition("ready", 1, "user");
  }

  function progress(osc) {
    if (!runtime.hookStatus) {
      runtime.oscProgress = osc;
      // OSC 9;4 state 0 removes the progress line (task finished or reset);
      // progress 100 with any active state also marks completion evidence.
      if (osc.progress >= 100 || osc.state === 0) runtime.oscCompletedAt = outputAt;
      // A later active progress report invalidates an earlier completion.
      else runtime.oscCompletedAt = 0;
    }
  }

  function agentStatus(status) {
    if (!status || typeof status.state !== "string") return;
    if (status.state === "working") {
      hook("agent.osc", "running");
      return;
    }
    if (status.state === "idle" || status.state === "clear") {
      // Some CLIs emit a baseline clear/idle while booting. A task that was
      // never armed should stay ready instead of becoming completed-unseen.
      if (!runtime.armed && !runtime.hookStatus) return;
      hook("agent.osc", "completed");
    }
  }

  function title(value) {
    runtime.title = value;
    if (runtime.hookStatus) return;
    const titleConfig = config.title;
    const titleWorking = titleConfig?.working?.some((pattern) => pattern.test(value)) ?? false;
    const titleIdle = titleConfig?.idle?.some((pattern) => pattern.test(value)) ?? false;
    if (titleWorking) {
      runtime.titleWorkingAt = outputAt;
      runtime.titleIdleAt = 0;
      runtime.pending = null;
      runtime.candidateAt = 0;
      runtime.oscCompletedAt = 0;
      if (runtime.armed && runtime.state !== "error") {
        transition("working", 0.85, "title", value);
      }
    } else if (titleIdle) {
      runtime.titleIdleAt = outputAt;
      if (!runtime.armed && runtime.state === "working") {
        transition("ready", 0.8, "title", value);
      }
    }
  }

  function output(data, now = Date.now()) {
    outputAt = now;
    const visible = oscParser.feed(data);
    // The parser must see every chunk to catch split OSC sequences, but the
    // heuristics only inspect the newest lines. Bounding the haystack keeps a
    // 64 KB PTY burst from doing full-text regex work.
    const clean = stripAnsi(visible.length > MAX_DETECTION_CHARS ? visible.slice(-MAX_DETECTION_CHARS) : visible);
    runtime.lastOutputAt = now;
    // A native lifecycle event owns this turn until input, launch or another
    // native event. A permission/confirmation dialog is the one exception:
    // some TUI versions render it without emitting a native waiting event.
    if (runtime.hookStatus) {
      if (runtime.hookStatus !== "waiting"
        && config.id !== "opencode"
        && config.patterns.error.some((pattern) => pattern.test(tailLines(clean, 4)))) {
        runtime.hookStatus = "failed";
        runtime.pending = null;
        transition("error", 0.92, "output", clean.trim().slice(-160));
        return;
      }
      const dialog = tailLines(clean, 8);
      if (config.patterns.waitingInput.some((pattern) => pattern.test(dialog))) {
        runtime.hookStatus = "waiting";
        runtime.armed = true;
        transition("awaiting-input", 0.88, "output", clean.trim().slice(-160));
      }
      return;
    }
    const recent = (runtime.signalTail + clean).slice(-EVIDENCE_TAIL);
    runtime.signalTail = recent.slice(-SIGNAL_TAIL);
    // One backward scan supplies every line window the heuristics need.
    const lines = lastLines(recent, 8);
    const evidence = lines.slice(-COMPLETION_LINES).join("\n");
    const dialog = lines.join("\n");
    const errorLines = lines.slice(-4).join("\n");
    const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
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
    if (runtime.hookStatus || runtime.state === "error") return;
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
    resetTask();
    oscParser.reset();
    transition(exitCode === 0 ? "stopped" : "error", 1, "process");
  }

  function hook(event, status, metadata = {}) {
    // Older installations may still report these as whole-turn completion.
    if (event === "SubagentStop" || (config.id === "claude" && event === "TaskCompleted")) return false;
    if (!["started", "running", "waiting", "completed", "failed"].includes(status)) return false;
    if (Number.isFinite(metadata.occurredAt)) {
      if (metadata.occurredAt < runtime.hookOccurredAt) return false;
      runtime.hookOccurredAt = metadata.occurredAt;
    }
    if (runtime.hookStatus === status) return true;
    resetTask();
    runtime.hookStatus = status;
    if (status === "started" || status === "running") {
      runtime.armed = true;
      transition("working", 0.9, "hook");
    } else if (status === "waiting") {
      runtime.armed = true;
      transition("awaiting-input", 0.9, "hook");
    } else if (status === "completed") {
      // Native completion clears tool grace and keeps its source/confidence.
      transition("completed-unseen", 0.95, "hook", event);
    } else if (status === "failed") {
      transition("error", 0.95, "hook", event);
    }
    return true;
  }

  return { runtime, input, launch, output, tick, viewed, exit, hook, config, agentStatus };
}

module.exports = { createDetector, stripAnsi, stripInputSequences, parseOscProgress, parseOscTitle };
