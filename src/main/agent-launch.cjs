const AGENT_COMMANDS = ["opencode", "claude", "codex", "pi"];
const KNOWN_AGENT_TYPES = new Set(["generic", ...AGENT_COMMANDS]);

function isAgentLaunchInput(value, agentType) {
  if (typeof value !== "string") return false;
  // A terminal can retain a stale label after an earlier CLI exits. Let an
  // explicit agent command at the shell still take the launch path, so its
  // banner does not light up as a completed task before identity updates.
  if (!KNOWN_AGENT_TYPES.has(agentType)) return false;
  const normalized = value.trimStart().toLowerCase();
  if (!normalized) return false;
  return AGENT_COMMANDS.some((command) =>
    (normalized === command
      || normalized.startsWith(`${command} `))
  // A fresh generic shell is the common launch path. A terminal that still
  // carries an old agent label after returning to the shell must not treat
  // the next typed command as a task; only the same or a new agent launch.
    && (agentType === "generic" || agentType === command));
}

function withOpenCodeStandalone(data, candidate, agentType) {
  if (agentType !== "generic" || typeof data !== "string" || typeof candidate !== "string") return data;
  const normalized = candidate.trim();
  if (!/^opencode(?:\s|$)/i.test(normalized)) return data;
  // Explicit server selection is an intentional escape hatch. Otherwise the
  // shared background service cannot see TermBeacon's per-PTY hook variables.
  if (/(?:^|\s)--(?:standalone|server)(?:\s|$)/i.test(normalized)) return data;
  const end = data.search(/[\r\n]/);
  if (end < 0) return data;
  const typed = data.slice(0, end);
  if (!typed.trim()) {
    // Interactive typing sends the command and the newline as separate chunks.
    // The command is already sitting on the shell line, so the flag has to be
    // appended to it here; rewriting only the same-chunk paste shape would let
    // plain `opencode` through and attach to the shared background service,
    // where the hook plugin cannot see TermBeacon's per-PTY variables.
    return ` --standalone${data.slice(end)}`;
  }
  const command = typed.replace(/^(\s*opencode)(?=\s|$)/i, "$1 --standalone");
  return `${command}${data.slice(end)}`;
}

module.exports = { AGENT_COMMANDS, isAgentLaunchInput, withOpenCodeStandalone };
