const AGENT_TYPES = new Set(["generic", "opencode", "codex", "claude", "pi"]);
const MAX_SESSION_ID_LENGTH = 256;

function normalizeSessionId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}

function getResumeSpec({ agentType, sessionId, cwd, shell = "cmd.exe" } = {}) {
  if (!AGENT_TYPES.has(agentType) || agentType === "generic") {
    return { supported: false, agentType: agentType || "generic", mode: "unsupported", reason: "该终端没有可用的 CLI 会话适配器" };
  }
  const id = normalizeSessionId(sessionId);
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
  } else {
    program = "codex";
    args = id ? ["resume", id] : ["resume", "--last"];
    mode = id ? "session-id" : "latest";
  }
  return { supported: true, agentType, mode, sessionId: id, cwd: typeof cwd === "string" ? cwd : undefined, program, args };
}

module.exports = { getResumeSpec, normalizeSessionId };
