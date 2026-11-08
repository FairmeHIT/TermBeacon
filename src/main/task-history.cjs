// Pure helpers for turning terminal input into bounded task metadata.

function cleanTaskPrompt(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function applyTaskEvent(items, event, prompt, metadata = {}) {
  const terminalTasks = items.filter((task) => task.terminalId === event.terminalId);
  const latest = terminalTasks.at(-1);
  const activeTask = latest && (latest.state === "working" || latest.state === "awaiting-input") ? latest : undefined;
  let next = items;
  if (event.current === "working") {
    if (activeTask) {
      next = items.map((task) => task.id === activeTask.id
        ? { ...task, state: "working", summary: event.summary || task.summary }
        : task);
    } else {
      next = [...items, {
        id: crypto.randomUUID(),
        terminalId: event.terminalId,
        startedAt: event.at,
        state: "working",
        ...(prompt ? { prompt } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
        ...(typeof metadata.batchId === "string" ? { batchId: metadata.batchId } : {}),
        ...(typeof metadata.retestOf === "string" ? { retestOf: metadata.retestOf } : {}),
        ...(Number.isInteger(metadata.attempt) && metadata.attempt > 0 ? { attempt: metadata.attempt } : {}),
      }];
    }
  } else if (event.current === "awaiting-input" && activeTask) {
    next = items.map((task) => task.id === activeTask.id
      ? { ...task, state: "awaiting-input", summary: event.summary || task.summary }
      : task);
  } else if (event.current === "completed-unseen" && activeTask) {
    next = items.map((task) => task.id === activeTask.id
      ? { ...task, state: "completed", finishedAt: event.at, summary: event.summary || task.summary }
      : task);
  } else if (event.current === "error" && activeTask) {
    next = items.map((task) => task.id === activeTask.id
      ? { ...task, state: "error", finishedAt: event.at, error: event.summary || task.error, summary: event.summary || task.summary }
      : task);
  } else if (event.current === "stopped" && activeTask) {
    next = items.map((task) => task.id === activeTask.id
      ? { ...task, state: "cancelled", finishedAt: event.at, summary: event.summary || task.summary }
      : task);
  }
  return next.length > 1000 ? next.slice(-1000) : next;
}

function settleTask(items, terminalId, state, at, detail) {
  const latest = items.filter((task) => task.terminalId === terminalId).at(-1);
  if (!latest || (latest.state !== "working" && latest.state !== "awaiting-input")) return items;
  return items.map((task) => task.id === latest.id
    ? { ...task, state, finishedAt: at, ...(detail ? { summary: detail, error: state === "error" ? detail : task.error } : {}) }
    : task);
}

function markInterrupted(items, at, detail = "应用重启，任务中断") {
  return items.map((task) => task.state === "working" || task.state === "awaiting-input"
    ? { ...task, state: "interrupted", finishedAt: at, recoveryState: "resumable", error: detail, summary: detail }
    : task);
}

function restoreAttachedTasks(items, terminalId, previouslyActive) {
  return items.map((task) => {
    const original = previouslyActive.get(task.id);
    return task.terminalId === terminalId && task.state === "interrupted" && original
      ? { ...original, recoveryState: "recovered" }
      : task;
  });
}

function restoredTerminalRecovery(terminal, existing) {
  if (existing) return "recovered";
  return terminal.agentType !== "generic" ? "resumable" : "none";
}

module.exports = { cleanTaskPrompt, applyTaskEvent, settleTask, markInterrupted, restoreAttachedTasks, restoredTerminalRecovery };
