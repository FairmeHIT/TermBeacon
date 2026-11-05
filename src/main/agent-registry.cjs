const common = {
  quietWindow: { candidateMs: 1200, confirmMs: 2500, maxToolGraceMs: 8000 },
  patterns: {
    working: [/Running|Executing|Thinking|Working|Searching|Tool/i],
    completion: [/Done|Completed|Finished|Summary|Task complete|任务完成/i],
    waitingInput: [/Allow|Deny|Yes\/No|Confirm|permission|继续吗|是否允许/i],
    error: [/\bError\b|API error|failed|失败|fatal/i],
    prompt: [/^\s*[>$#❯]\s*$/m],
    toolStart: [/Running|Executing|Calling|Tool|Searching|读取|写入|执行/i],
    toolEnd: [/Tool result|completed|finished|Done|Tests passed|结果/i],
  },
};

module.exports = {
  generic: { id: "generic", displayName: "Generic CLI", ...common },
  opencode: {
    id: "opencode",
    displayName: "opencode",
    ...common,
    patterns: {
      ...common.patterns,
      working: [/Thinking|Running tool|Applying patch|正在/i],
      completion: [/Done|Changes applied|Task complete|完成/i],
    },
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    ...common,
    patterns: {
      ...common.patterns,
      working: [/Working|Reasoning|Running command|Applying patch/i],
      completion: [/Task complete|Completed|Done|Summary/i],
    },
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    ...common,
    patterns: {
      ...common.patterns,
      working: [/Thinking|Running|Tool use|Reading|Writing/i],
      completion: [/Done|Summary|completed/i],
    },
    hooks: { supportedEvents: ["Stop", "TaskCompleted", "Notification", "SubagentStop"], timeoutMs: 5000 },
  },
};


