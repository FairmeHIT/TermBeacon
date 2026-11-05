import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentState, AgentType, PersistedState, PtyErrorEvent, PtyExitEvent, PtyHostExitEvent, PtyOutputEvent, StateUpdateEvent, TerminalInstance } from "../shared/types";
import "./styles.css";

declare global {
  interface CliInfo {
    id: AgentType;
    command: string;
    installed: boolean;
    executable?: string;
    version?: string;
  }

  interface Window {
    termbeacon: {
      loadState(): Promise<PersistedState>;
      saveState(state: PersistedState): Promise<boolean>;
      discoverCli(): Promise<Record<string, CliInfo>>;
      createTerminal(request: unknown): Promise<unknown>;
      write(request: unknown): void;
      resize(request: unknown): void;
      kill(request: unknown): void;
      viewed(terminalId: string): void;
      onOutput(listener: (event: PtyOutputEvent) => void): () => void;
      onState(listener: (event: StateUpdateEvent) => void): () => void;
      onExit(listener: (event: PtyExitEvent) => void): () => void;
      onError(listener: (event: PtyErrorEvent) => void): () => void;
      onHost(listener: (event: PtyHostExitEvent) => void): () => void;
    };
  }
}

const stateLabel: Record<AgentState, string> = {
  working: "工作中",
  "completed-unseen": "已完成",
  ready: "就绪",
  "awaiting-input": "等待输入",
  error: "异常",
  stopped: "已停止",
};

const stateClass: Record<AgentState, string> = {
  working: "working",
  "completed-unseen": "completed",
  ready: "ready",
  "awaiting-input": "awaiting",
  error: "error",
  stopped: "stopped",
};

const agents: AgentType[] = ["generic", "opencode", "codex", "claude"];

function newTerminal(index: number): TerminalInstance {
  return {
    id: crypto.randomUUID(),
    title: `终端 ${index}`,
    cwd: "C:\\\\",
    agentType: "generic",
    state: "ready",
    alive: false,
    lastActivityAt: Date.now(),
  };
}

function App() {
  const [terminals, setTerminals] = useState<TerminalInstance[]>(() => [newTerminal(1)]);
  const [activeId, setActiveId] = useState<string>(() => terminals[0].id);
  const [hydrated, setHydrated] = useState(false);
  const [cliStatus, setCliStatus] = useState<Record<string, CliInfo>>({});
  const terminalNodes = useRef(new Map<string, HTMLDivElement>());
  const terminalViews = useRef(new Map<string, Terminal>());
  const fitAddons = useRef(new Map<string, FitAddon>());

  const active = useMemo(() => terminals.find((terminal) => terminal.id === activeId) ?? terminals[0], [activeId, terminals]);

  useEffect(() => {
    void window.termbeacon.discoverCli().then(setCliStatus);
    void window.termbeacon.loadState().then((state) => {
      if (state.terminals.length > 0) {
        setTerminals(state.terminals.map((terminal) => ({ ...terminal, alive: false, state: "stopped" as AgentState })));
        setActiveId(state.activeTerminalId ?? state.terminals[0].id);
      }
      setHydrated(true);
    });
    const disposeOutput = window.termbeacon.onOutput((event) => {
      terminalViews.current.get(event.terminalId)?.write(event.data);
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, lastActivityAt: event.at, lastOutputSummary: event.data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().slice(-90) }
        : item));
    });
    const disposeState = window.termbeacon.onState((event) => {
      setTerminals((items) => items.map((item) => item.id === event.terminalId ? { ...item, state: event.current, lastOutputSummary: event.summary ?? item.lastOutputSummary, alive: event.current !== "stopped" } : item));
    });
    const disposeExit = window.termbeacon.onExit((event) => {
      setTerminals((items) => items.map((item) => item.id === event.terminalId ? { ...item, alive: false, state: event.reason === "user-kill" || event.exitCode === 0 ? "stopped" : "error" } : item));
    });
    const disposeError = window.termbeacon.onError((event) => {
      if (!event.terminalId) return;
      setTerminals((items) => items.map((item) => item.id === event.terminalId
        ? { ...item, alive: false, state: "error", lastOutputSummary: String(event.message || "PTY request failed").slice(-90) }
        : item));
    });
    const disposeHost = window.termbeacon.onHost((event) => {
      if (event.type !== "pty:host-exit" && event.type !== "pty:host-disconnected") return;
      setTerminals((items) => items.map((item) => item.alive
        ? { ...item, alive: false, state: "error", lastOutputSummary: event.message || "PTY host 已断开" }
        : item));
    });
    return () => { disposeOutput(); disposeState(); disposeExit(); disposeError(); disposeHost(); };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    terminals.forEach((terminal) => {
      if (terminalViews.current.has(terminal.id)) return;
      const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: "Cascadia Mono, Consolas, monospace",
        fontSize: 14,
        scrollback: 20000,
        theme: { background: "#111827", foreground: "#e5e7eb", cursor: "#93c5fd" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.onData((data) => window.termbeacon.write({ terminalId: terminal.id, data }));
      terminalViews.current.set(terminal.id, term);
      fitAddons.current.set(terminal.id, fit);
      const node = terminalNodes.current.get(terminal.id);
      if (node) term.open(node);
      void window.termbeacon.createTerminal({
        terminalId: terminal.id,
        title: terminal.title,
        cwd: terminal.cwd,
        shell: "cmd.exe",
        args: [],
        cols: 120,
        rows: 32,
        agentType: terminal.agentType,
      }).then(() => {
        setTerminals((items) => items.map((item) => item.id === terminal.id ? { ...item, alive: true, state: "ready" } : item));
        requestAnimationFrame(() => fitTerminal(terminal.id));
      }).catch((error: Error) => {
        setTerminals((items) => items.map((item) => item.id === terminal.id
          ? { ...item, alive: false, state: "error", lastOutputSummary: error.message.slice(-90) }
          : item));
      });
    });
  }, [terminals, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const handle = window.setTimeout(() => {
      const state: PersistedState = {
        schemaVersion: 1,
        workspaces: [{ id: "default", name: "默认工作区", terminalIds: terminals.map((terminal) => terminal.id) }],
        terminals,
        activeTerminalId: activeId,
      };
      void window.termbeacon.saveState(state);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [terminals, activeId, hydrated]);

  useEffect(() => {
    terminalViews.current.forEach((term, id) => {
      const node = terminalNodes.current.get(id);
      if (node) node.style.display = id === activeId ? "block" : "none";
    });
    requestAnimationFrame(() => fitTerminal(activeId));
  }, [activeId]);

  function fitTerminal(id: string) {
    const fit = fitAddons.current.get(id);
    if (!fit) return;
    try {
      fit.fit();
      const term = terminalViews.current.get(id);
      if (term) window.termbeacon.resize({ terminalId: id, cols: term.cols, rows: term.rows });
    } catch { /* container may not be visible yet */ }
  }

  function selectTerminal(id: string) {
    setActiveId(id);
    window.termbeacon.viewed(id);
    setTerminals((items) => items.map((item) => item.id === id && item.state === "completed-unseen" ? { ...item, state: "ready" } : item));
    requestAnimationFrame(() => terminalViews.current.get(id)?.focus());
  }

  function addTerminal() {
    const terminal = newTerminal(terminals.length + 1);
    setTerminals((items) => [...items, terminal]);
    setActiveId(terminal.id);
  }

  function killTerminal(id: string) {
    window.termbeacon.kill({ terminalId: id, reason: "user-kill" });
    setTerminals((items) => items.map((item) => item.id === id ? { ...item, state: "stopped", alive: false } : item));
  }

  function startAgent() {
    if (!active || active.agentType === "generic") return;
    const info = cliStatus[active.agentType];
    if (!info?.installed) return;
    window.termbeacon.write({ terminalId: active.id, data: `${info.command}\r` });
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand-row"><div><div className="brand">TermBeacon</div><div className="subtitle">CLI Agent 工作台</div></div><button className="add-button" onClick={addTerminal} title="新建终端">+</button></div>
      <div className="terminal-list">
        {terminals.map((terminal) => <button key={terminal.id} className={`terminal-item ${terminal.id === activeId ? "active" : ""}`} onClick={() => selectTerminal(terminal.id)}>
          <span className={`status-dot ${stateClass[terminal.state]}`} />
          <span className="terminal-copy"><strong>{terminal.title}</strong><small>{terminal.agentType} · {stateLabel[terminal.state]}</small><em>{terminal.lastOutputSummary || terminal.cwd}</em></span>
          {terminal.id === activeId && <span className="active-mark">●</span>}
        </button>)}
      </div>
      <div className="cli-health">
        <div className="section-label">CLI 检测</div>
        {agents.filter((agent) => agent !== "generic").map((agent) => {
          const info = cliStatus[agent];
          return <div className="cli-row" key={agent}><span className={`cli-led ${info?.installed ? "online" : "offline"}`} /><span>{agent}</span><small>{info?.installed ? (info.version || "已安装") : "未找到"}</small></div>;
        })}
      </div>
    </aside>
    <section className="workspace">
      <header className="workspace-header"><div><strong>{active?.title}</strong><span>{active?.cwd}</span></div><div className="header-actions"><select value={active?.agentType} onChange={(event) => setTerminals((items) => items.map((item) => item.id === activeId ? { ...item, agentType: event.target.value as AgentType } : item))}>{agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}</select><button onClick={startAgent} disabled={!active || active.agentType === "generic" || !cliStatus[active.agentType]?.installed}>启动 Agent</button><button onClick={() => active && killTerminal(active.id)}>停止</button></div></header>
      <div className="terminal-stage">{terminals.map((terminal) => <div key={terminal.id} ref={(node) => { if (node) terminalNodes.current.set(terminal.id, node); }} className="terminal-host" />)}</div>
    </section>
  </main>;
}

export default App;




