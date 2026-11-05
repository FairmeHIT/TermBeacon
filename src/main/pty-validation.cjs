const path = require("node:path");
const { defaultShell, isAbsoluteCwd } = require("./platform.cjs");

const AGENT_TYPES = new Set(["generic", "opencode", "codex", "claude"]);
const MAX_TERMINAL_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_CWD_LENGTH = 32760;
const MAX_SHELL_LENGTH = 2048;
const MAX_ARGUMENT_LENGTH = 8192;
const MAX_ARGUMENTS = 128;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_LENGTH = 32760;
const MIN_DIMENSION = 2;
const MAX_DIMENSION = 500;

function protocolError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requireString(value, field, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw protocolError("INVALID_REQUEST", `${field} must be a non-empty string of at most ${maxLength} characters`, { field });
  }
  return value;
}

function normalizeDimension(value, field, fallback) {
  const dimension = value === undefined ? fallback : value;
  if (!Number.isInteger(dimension) || dimension < MIN_DIMENSION || dimension > MAX_DIMENSION) {
    throw protocolError("INVALID_DIMENSION", `${field} must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`, { field });
  }
  return dimension;
}

function normalizeCreateRequest(message) {
  if (!message || typeof message !== "object") throw protocolError("INVALID_REQUEST", "pty:create payload must be an object");
  const terminalId = requireString(message.terminalId, "terminalId", MAX_TERMINAL_ID_LENGTH);
  const title = requireString(message.title || terminalId, "title", MAX_TITLE_LENGTH);
  const cwd = requireString(message.cwd || path.sep, "cwd", MAX_CWD_LENGTH);
  if (!isAbsoluteCwd(cwd)) {
    throw protocolError("INVALID_CWD", "cwd must be an absolute path", { field: "cwd" });
  }
  const shell = requireString(message.shell || defaultShell(), "shell", MAX_SHELL_LENGTH);
  const args = message.args === undefined ? [] : message.args;
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARGUMENT_LENGTH)) {
    throw protocolError("INVALID_ARGUMENTS", `args must contain at most ${MAX_ARGUMENTS} string values`, { field: "args" });
  }
  const env = message.env === undefined ? {} : message.env;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > MAX_ENV_ENTRIES) {
    throw protocolError("INVALID_ENV", `env must be an object with at most ${MAX_ENV_ENTRIES} entries`, { field: "env" });
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key || key.length > 256 || typeof value !== "string" || value.length > MAX_ENV_VALUE_LENGTH) {
      throw protocolError("INVALID_ENV", "env keys and values exceed the supported limits", { field: "env" });
    }
  }
  const agentType = message.agentType || "generic";
  if (!AGENT_TYPES.has(agentType)) throw protocolError("INVALID_AGENT", `unsupported agent type: ${agentType}`, { field: "agentType" });
  return {
    terminalId,
    title,
    cwd,
    shell,
    args: [...args],
    env: { ...env },
    cols: normalizeDimension(message.cols, "cols", 120),
    rows: normalizeDimension(message.rows, "rows", 32),
    agentType,
  };
}

function normalizeWriteRequest(message) {
  if (!message || typeof message !== "object") throw protocolError("INVALID_REQUEST", "pty:write payload must be an object");
  return {
    terminalId: requireString(message.terminalId, "terminalId", MAX_TERMINAL_ID_LENGTH),
    data: requireString(message.data, "data", 1024 * 1024),
  };
}

function normalizeResizeRequest(message) {
  if (!message || typeof message !== "object") throw protocolError("INVALID_REQUEST", "pty:resize payload must be an object");
  return {
    terminalId: requireString(message.terminalId, "terminalId", MAX_TERMINAL_ID_LENGTH),
    cols: normalizeDimension(message.cols, "cols"),
    rows: normalizeDimension(message.rows, "rows"),
  };
}

function normalizeTerminalRequest(message, operation) {
  if (!message || typeof message !== "object") throw protocolError("INVALID_REQUEST", `${operation} payload must be an object`);
  return { terminalId: requireString(message.terminalId, "terminalId", MAX_TERMINAL_ID_LENGTH) };
}

module.exports = {
  AGENT_TYPES,
  normalizeCreateRequest,
  normalizeWriteRequest,
  normalizeResizeRequest,
  normalizeTerminalRequest,
  protocolError,
};
