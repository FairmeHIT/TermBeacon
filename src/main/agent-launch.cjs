const AGENT_COMMANDS = ["opencode", "claude", "codex"];

function isAgentLaunchInput(value, agentType) {
  if (agentType !== "generic" || typeof value !== "string") return false;
  const normalized = value.trimStart().toLowerCase();
  if (!normalized) return false;
  return AGENT_COMMANDS.some((command) => normalized === command
    || normalized.startsWith(`${command} `));
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
  const command = data.slice(0, end).replace(/^(\s*opencode)(?=\s|$)/i, "$1 --standalone");
  return `${command}${data.slice(end)}`;
}

module.exports = { AGENT_COMMANDS, isAgentLaunchInput, withOpenCodeStandalone };
