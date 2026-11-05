const registry = require("./agent-registry.cjs");

function stripAnsi(value) {
  return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function parseOscProgress(value) {
  const match = value.match(/\u001b\]9;4;(\d+);(\d+)(?:\u0007|\u001b\\)/);
  if (!match) return undefined;
  return { state: Number(match[1]), progress: Number(match[2]) };
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
    pending: null,
  };

  function transition(current, confidence, source, summary) {
    if (runtime.state === current) return;
    const previous = runtime.state;
    runtime.state = current;
    emit({ previous, current, confidence, source, summary, at: Date.now() });
  }

  function input(data) {
    if (/[^\u0000-\u001f]/.test(data)) {
      runtime.armed = true;
      runtime.toolInFlight = false;
      runtime.toolStartedAt = 0;
      runtime.pending = null;
      runtime.candidateAt = 0;
      runtime.signalTail = "";
      runtime.oscProgress = undefined;
      runtime.oscCompletedAt = 0;
      transition("working", 0.55, "user");
    }
  }

  function output(data, now = Date.now()) {
    const clean = stripAnsi(data);
    const osc = parseOscProgress(data);
    if (osc) {
      runtime.oscProgress = osc;
      if (osc.progress >= 100 && osc.state !== 0) runtime.oscCompletedAt = now;
    }
    const signalText = (runtime.signalTail + clean).slice(-4096);
    runtime.signalTail = signalText.slice(-512);
    runtime.lastOutputAt = now;
    if (config.patterns.waitingInput.some((pattern) => pattern.test(signalText))) {
      transition("awaiting-input", 0.78, "output", clean.trim().slice(-160));
      return;
    }
    if (config.patterns.error.some((pattern) => pattern.test(signalText))) {
      transition("error", 0.7, "output", clean.trim().slice(-160));
      return;
    }
    if (config.patterns.toolStart.some((pattern) => pattern.test(clean))) {
      runtime.toolInFlight = true;
      runtime.toolStartedAt = now;
    }
    if (config.patterns.toolEnd.some((pattern) => pattern.test(clean))) {
      runtime.toolInFlight = false;
      runtime.toolStartedAt = 0;
    }
    if (runtime.armed || config.patterns.working.some((pattern) => pattern.test(clean))) {
      runtime.armed = true;
      transition("working", 0.6, "output", clean.trim().slice(-160));
    }
    const hasPrompt = config.patterns.prompt.some((pattern) => pattern.test(clean.trim()))
      || config.patterns.prompt.some((pattern) => pattern.test(signalText.trim()));
    const hasCompletion = config.patterns.completion.some((pattern) => pattern.test(signalText));
    if (runtime.armed && (hasPrompt || hasCompletion)) {
      runtime.candidateAt = now;
      runtime.pending = {
        summary: clean.trim().slice(-160),
        source: hasCompletion ? "completion" : runtime.oscCompletedAt ? "osc+prompt" : "prompt",
      };
    }
  }

  function tick(now = Date.now()) {
    if (!runtime.pending) return;
    const quietFor = now - runtime.lastOutputAt;
    const candidateFor = now - runtime.candidateAt;
    const toolGraceElapsed = !runtime.toolInFlight
      || quietFor >= config.quietWindow.maxToolGraceMs;
    if (!toolGraceElapsed) return;
    if (quietFor >= config.quietWindow.candidateMs && candidateFor >= config.quietWindow.confirmMs) {
      transition("completed-unseen", 0.82, "output", runtime.pending.summary);
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

  return { runtime, input, output, tick, viewed, exit, hook, config };
}

module.exports = { createDetector, stripAnsi, parseOscProgress };

