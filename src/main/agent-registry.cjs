const common = {
  quietWindow: { candidateMs: 1200, confirmMs: 2500, maxToolGraceMs: 8000 },
  patterns: {
    working: [/Running|Executing|Thinking|Working|Searching|Tool/i],
    completion: [/Task complete|Completed(?!\s+in\b)|Done(?!\s+in\b)|Finished(?!\s+in\b)|完成/i],
    waitingInput: [
      /\b(?:allow|deny|confirm|approve)\b[^\n]{0,80}\?/i,
      /\bdo you want to (?:proceed|continue|allow|run)\b/i,
      /^\s*[❯›>]?\s*\d+[.)]\s*(?:yes|no)\b/im,
      /\b(?:allow once|always allow|reject)\b/i,
      /是否(?:允许|继续|确认|执行)/,
      /继续吗[？?]?/,
    ],
    error: [
      /^\s*(?:error|fatal|panic)[:：]/im,
      /\b(?:command not found|is not recognized as an internal or external command)\b/i,
      /\b(?:ENOENT|EACCES|ECONNREFUSED)\b/,
      /\b(?:API error|request failed|fatal error|stream error)\b/i,
      /Stream disconnected before completion/i,
      /servers are currently overloaded/i,
      /(?:失败|错误)[:：]/,
    ],
    // A prompt is only accepted on the last non-empty line. These cover bare
    // prompts plus the common cmd.exe, PowerShell and bash/zsh shapes.
    prompt: [
      /^\s*[>$#❯›%]\s*$/,
      /^\s*PS [^\n>]*>\s*$/,
      /^\s*[A-Za-z]:\\[^\n>]*>\s*$/,
      /^\s*[\w.-]+@[\w.-]+:[^\n]*[$#%]\s*$/,
      /^\s*[~/][^\n]*[$#%]\s*$/,
    ],
    toolStart: [
      /\b(?:running|executing|calling)\s+(?:a\s+)?(?:tool|command)\b/i,
      /\btool use\b/i,
      /\bapplying patch\b/i,
      /(?:执行|读取|写入)(?:工具|命令|文件|目录)/,
    ],
    toolEnd: [
      /\btool result\b/i,
      /\btests passed\b/i,
      /\b(?:completed|finished)\b/i,
      /结果[:：]?/,
    ],
  },
};

module.exports = {
  generic: { id: "generic", displayName: "Generic CLI", ...common },
  opencode: {
    id: "opencode",
    displayName: "opencode",
    ...common,
    // opencode's TUI reports `OC | <task>` in the window title while a turn
    // runs, and it never goes back to `OpenCode` afterwards (verified with two
    // real captures: plugin-probe-standalone and plugin-probe-attached both end
    // on `OC | ...`). So the title can only start a turn, never finish one:
    // completion comes from the hook plugin (`hooks/opencode/termbeacon.js`),
    // which needs `opencode --standalone` for its per-PTY environment.
    title: {
      working: [/^OC\s*[|｜]/],
    },
    patterns: {
      ...common.patterns,
      working: [/Thinking|Running tool|Applying patch|Retry(?:ing)?|正在|重试/i],
      completion: [/Changes applied|Task complete|Done(?!\s+in\b)|完成/i],
    },
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    ...common,
    // Codex writes a Braille spinner into the terminal title while working and
    // a plain title when the turn ends. The capture shows brief plain-title
    // gaps (~2s); the 2.5s confirm window filters them.
    title: {
      working: [/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/],
      idle: [/^(?![⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s).+/],
    },
    patterns: {
      ...common.patterns,
      working: [/Working|Reasoning|Running command|Applying patch/i],
      completion: [/Task complete|Completed(?!\s+in\b)|Done(?!\s+in\b)|Summary/i],
    },
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    ...common,
    // Claude Code uses half-circle spinner glyphs while working and a static
    // star (✳) when idle.
    title: {
      working: [/^[◐◑◒◓◔◕◖◗]\s+Claude Code/],
      idle: [/^✳\s+Claude Code/, /^Claude Code/],
    },
    patterns: {
      ...common.patterns,
      working: [/Thinking|Running|Tool use|Reading|Writing/i],
      completion: [/Task completed|Done(?!\s+in\b)|Summary|完成/i],
    },
    hooks: { supportedEvents: ["Stop", "TaskCompleted", "Notification", "SubagentStop"], timeoutMs: 5000 },
  },
};
