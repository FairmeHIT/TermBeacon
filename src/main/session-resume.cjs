const AGENT_TYPES = new Set(["generic", "opencode", "codex", "claude", "pi"]);
const MAX_SESSION_ID_LENGTH = 256;

// opencode validates `--session` with a schema that requires the "ses" prefix
// (its own ids look like `ses_0193a28f4ffeZQr`). Claude Code and Codex use
// UUIDs. A persisted id can come from the wrong CLI — a terminal that ran
// `claude` and was later labelled `opencode` keeps the UUID — and the CLI then
// aborts before it can fall back to its own latest session:
//   Error: Expected a string starting with "ses"  at ["sessionID"]
const OPENCODE_SESSION_ID = /^ses[_-]/i;

function normalizeSessionId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}

// Only an id the target CLI can actually open is worth passing. An opencode id
// is never valid for Claude/Codex and a Claude/Codex id is never valid for
// opencode, so a mismatched id is dropped instead of producing a CLI error.
function sessionIdFitsAgent(agentType, value) {
  const id = normalizeSessionId(value);
  if (!id) return false;
  if (agentType === "opencode") return OPENCODE_SESSION_ID.test(id);
  if (agentType === "claude" || agentType === "codex") return !OPENCODE_SESSION_ID.test(id);
  return true;
}

function getResumeSpec({ agentType, sessionId, sessionAgent, cwd, shell = "cmd.exe" } = {}) {
  if (!AGENT_TYPES.has(agentType) || agentType === "generic") {
    return { supported: false, agentType: agentType || "generic", mode: "unsupported", reason: "该终端没有可用的 CLI 会话适配器" };
  }
  const requested = normalizeSessionId(sessionId);
  const id = requested && sessionAgent === agentType && sessionIdFitsAgent(agentType, requested) ? requested : undefined;
  // The stored id belongs to another CLI (or predates the current adapter).
  // Passing it would make the CLI reject the whole resume command, so the id is
  // dropped and the note explains why.
  const notes = [];
  // Codex has no "latest session" fallback any more (it opens a picker), so the
  // note must not claim one; it only explains that the id was discarded.
  if (requested && !id) notes.push(`会话 ID 与 ${agentType} 不匹配，已忽略该 ID`);
  let program;
  let args;
  let mode;
  if (agentType === "claude") {
    program = "claude";
    args = id ? ["--resume", id] : ["--continue"];
    mode = id ? "session-id" : "latest";
  } else if (agentType === "opencode") {
    program = "opencode";
    args = id ? ["--standalone", "--session", id] : ["--standalone", "--continue"];
    mode = id ? "session-id" : "latest";
  } else if (agentType === "pi") {
    program = "pi";
    args = id ? ["--session", id] : ["--continue"];
    mode = id ? "session-id" : "latest";
  } else if (id) {
    program = "codex";
    args = ["resume", id];
    mode = "session-id";
  } else {
    // `codex resume --last` filters by the shell's current cwd and returns the
    // newest conversation in the folder. Every terminal in one workspace would
    // therefore reopen the same thread. The picker has no such fallback: the
    // user (or a later captured id) decides which conversation belongs here.
    program = "codex";
    args = ["resume"];
    mode = "picker";
    notes.push("未记录该终端的 Codex 会话，已打开历史会话列表，请选择它原来的会话");
  }
  return {
    supported: true,
    agentType,
    mode,
    sessionId: id,
    cwd: typeof cwd === "string" ? cwd : undefined,
    program,
    args,
    ...(notes.length ? { note: notes.join("；") } : {}),
  };
}

module.exports = { getResumeSpec, normalizeSessionId, sessionIdFitsAgent };
