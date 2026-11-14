import { useEffect, useRef, useState } from "react";
import type { AgentCliId, CliAction, CliPlan, CliProgress, CliScan, ShellType } from "../shared/types";
import { settingsText, type SettingsLocale } from "./settings-i18n";
import type { ThemeSetting } from "./App";
import "./settings.css";

const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "midnight", label: "午夜蓝" },
  { value: "forest", label: "森林绿" },
  { value: "sepia", label: "暖纸米色" },
];

type Props = {
  locale: SettingsLocale;
  onLocale: (locale: SettingsLocale) => void;
  theme: ThemeSetting;
  onTheme: (theme: ThemeSetting) => void;
  shell: ShellType;
  shellOptions: { value: ShellType; label: string }[];
  onShell: (shell: ShellType) => void;
  version: string;
  updateHint: string;
  updateBusy: boolean;
  updateDownloaded?: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onRestartHost: () => Promise<void>;
  onBack: () => void;
  onLaunch: (id: AgentCliId) => Promise<void>;
};

const initials: Record<AgentCliId, string> = { codex: "C", opencode: "O", claude: "✳", pi: "π" };
const sourceLabel = { managed: "TermBeacon 托管", system: "系统安装", missing: "未安装" };
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error);
const working = (event?: CliProgress) => event && !["done", "error"].includes(event.phase);

export default function SettingsPage(props: Props) {
  const t = (source: string, values?: Record<string, string | number>) => settingsText(props.locale, source, values);
  const [section, setSection] = useState<"general" | "agents">("general");
  const [scan, setScan] = useState<CliScan | null>(null);
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<AgentCliId>("codex");
  const [error, setError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<CliPlan | null>(null);
  const [progress, setProgress] = useState<Partial<Record<AgentCliId, CliProgress>>>({});
  const [logs, setLogs] = useState<Partial<Record<AgentCliId, string[]>>>({});
  const [launching, setLaunching] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const refreshSequence = useRef(0);
  const previewSequence = useRef(0);
  const executionSequence = useRef<Partial<Record<AgentCliId, number>>>({});

  async function refresh(clearError = false) {
    const sequence = ++refreshSequence.current;
    setChecking(true);
    if (clearError) setError("");
    try {
      const result = await window.termbeacon.scanCli();
      if (!mounted.current || sequence !== refreshSequence.current) return;
      setScan(result);
      setProgress((previous) => {
        const next = { ...previous };
        result.agents.forEach((item) => { if (item.operation && item.operation.at >= (next[item.id]?.at || 0)) next[item.id] = item.operation; });
        return next;
      });
    } catch (cause) { if (mounted.current && sequence === refreshSequence.current) setError(messageOf(cause)); }
    finally { if (mounted.current && sequence === refreshSequence.current) setChecking(false); }
  }
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    void refresh();
    const unsubscribe = window.termbeacon.onCliProgress((event) => {
      setProgress((previous) => (previous[event.id]?.at || 0) > event.at ? previous : ({ ...previous, [event.id]: event }));
      if (event.message) setLogs((previous) => ({ ...previous, [event.id]: [...(previous[event.id] || []), event.message].slice(-30) }));
      if (["done", "error"].includes(event.phase)) void refresh();
    });
    return () => { mounted.current = false; refreshSequence.current++; previewSequence.current++; unsubscribe(); };
  }, []);

  async function preview(id: AgentCliId, action: CliAction) {
    const sequence = ++previewSequence.current;
    setPlanning(true);
    setError("");
    setPlan(null);
    try { const result = await window.termbeacon.planCli({ id, action }); if (mounted.current && sequence === previewSequence.current) setPlan(result); }
    catch (cause) { if (mounted.current && sequence === previewSequence.current) setError(messageOf(cause)); }
    finally { if (mounted.current && sequence === previewSequence.current) setPlanning(false); }
  }
  async function execute() {
    if (!plan) return;
    const current = plan;
    const sequence = (executionSequence.current[current.id] || 0) + 1;
    executionSequence.current[current.id] = sequence;
    setPlan(null);
    setError("");
    setLogs((previous) => ({ ...previous, [current.id]: [] }));
    setProgress((previous) => ({ ...previous, [current.id]: { id: current.id, action: current.action, phase: "starting", message: "准备中…", at: Date.now() } }));
    try {
      await window.termbeacon.executeCli({ token: current.token });
      // IPC success is authoritative even if the progress event was lost or
      // its process clock was a few milliseconds behind the renderer clock.
      if (mounted.current && executionSequence.current[current.id] === sequence) {
        setProgress((previous) => ({ ...previous, [current.id]: { id: current.id, action: current.action, phase: "done", message: "操作完成，新启动的 CLI 将使用更新后的配置。", at: Date.now() } }));
      }
    }
    catch (cause) {
      if (mounted.current && executionSequence.current[current.id] === sequence) {
        const message = messageOf(cause);
        setError(message);
        setProgress((previous) => ({ ...previous, [current.id]: { id: current.id, action: current.action, phase: "error", message, at: Date.now() } }));
      }
    }
    finally { if (mounted.current) await refresh(); }
  }
  async function launch(id: AgentCliId) {
    setLaunching(true);
    setError("");
    try { await props.onLaunch(id); }
    catch (cause) { if (mounted.current) setError(messageOf(cause)); }
    finally { if (mounted.current) setLaunching(false); }
  }
  const agent = scan?.agents.find((item) => item.id === selected);
  const operation = progress[selected];
  const disabled = Boolean(working(operation) || planning || launching);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (plan) setPlan(null);
      else props.onBack();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [plan, props.onBack]);

  return <section className="settings-page" lang={props.locale} aria-label={t("设置页面")}>
    <nav className="settings-nav" aria-label={t("设置分类")}>
      <button className="settings-back" onClick={props.onBack}><span aria-hidden="true">←</span> {t("返回终端")}</button>
      <div className="settings-nav-title">{t("设置")}</div>
      <button className={section === "general" ? "selected" : ""} aria-current={section === "general" ? "page" : undefined} onClick={() => setSection("general")}><span aria-hidden="true">◒</span> {t("常规")}</button>
      <button className={section === "agents" ? "selected" : ""} aria-current={section === "agents" ? "page" : undefined} onClick={() => setSection("agents")}><span aria-hidden="true">⌘</span> Agent CLI</button>
      <span className="settings-nav-version">TermBeacon {props.version}</span>
    </nav>
    <div className="settings-scroll">
      <div className="settings-content">
        <header className="settings-header">
          <div><p className="settings-eyebrow">{t("偏好与管理")}</p><h1 ref={heading} tabIndex={-1}>{section === "general" ? t("常规") : "Agent CLI"}</h1><p>{t(section === "general" ? "让工作环境保持顺手。" : "管理编程助手的安装、版本与状态接入。")}</p></div>
          {section === "agents" && <button className="settings-button" onClick={() => void refresh(true)} disabled={checking}>{t(checking ? "检测中…" : "重新检测")}</button>}
        </header>
        {error && <div className="settings-notice error" role="alert"><span>{t(error)}</span><button onClick={() => setError("")} aria-label={t("关闭提示")}>×</button></div>}
        {section === "general" ? <div className="general-settings">
          <section className="preference-section"><h2>{t("外观")}</h2><p>{t("选择适合当前环境的主题。")}</p>
            <div className="appearance-options" role="group" aria-label={t("主题")}>
              {THEME_OPTIONS.map((option) => <button key={option.value} className={`appearance-option ${props.theme === option.value ? "selected" : ""}`} aria-pressed={props.theme === option.value} onClick={() => props.onTheme(option.value)}>
                <span className={`appearance-preview ${option.value}`} aria-hidden="true"><i /><span><b /><b /><b /></span></span><span>{t(option.label)}<span className="appearance-check" aria-hidden="true">{props.theme === option.value ? "✓" : ""}</span></span>
              </button>)}
            </div>
          </section>
          <section className="preference-row"><div><h2><label htmlFor="settings-language">{props.locale === "zh-CN" ? "语言 / Language" : t("语言")}</label></h2><p>{t("选择设置页面的显示语言，即时生效并自动保存。")}</p></div><select id="settings-language" value={props.locale} onChange={(event) => props.onLocale(event.target.value as SettingsLocale)}><option value="zh-CN" lang="zh-CN">简体中文</option><option value="en" lang="en">English</option></select></section>
          <section className="preference-row"><div><h2>{t("默认 Shell")}</h2><p>{t("用于之后新建的终端。")}</p></div><select value={props.shell} onChange={(event) => props.onShell(event.target.value as ShellType)} aria-label={t("默认 Shell")}>{props.shellOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select></section>
          <section className="preference-row"><div><h2>{t("应用更新")} <span className="settings-version">{props.version || t("版本未知")}</span></h2><p role="status">{props.updateHint || t("检查并获取 TermBeacon 的新版本。")}</p></div><button className="settings-button" onClick={props.updateDownloaded ? props.onInstallUpdate : props.onCheckUpdate} disabled={props.updateBusy}>{t(props.updateDownloaded ? "重启并安装" : props.updateBusy ? "检查中…" : "检查更新")}</button></section>
          <section className="preference-row"><div><h2>{t("终端后台服务")}</h2><p>{t("升级状态检测组件后，可在任务结束时重启服务。此操作会关闭当前所有终端进程。")}</p></div><button className="settings-button" disabled={restarting} onClick={() => {
            setRestarting(true);
            void props.onRestartHost().catch((cause) => setError(messageOf(cause))).finally(() => setRestarting(false));
          }}>{t(restarting ? "重启中…" : "重启服务")}</button></section>
        </div> : <>
          {!scan && <div className="settings-empty" role="status">{t(checking ? "正在检测本机 CLI…" : "暂未获取到 CLI 信息。")}</div>}
          {scan && <>
            {!scan.runtime.ready && <div className="settings-notice">{t(scan.runtime.message)}</div>}
            <div className="cli-layout">
              <div className="cli-list" role="group" aria-label={t("选择 Agent CLI")}>
                {scan.agents.map((item) => <button key={item.id} className={`cli-list-item ${selected === item.id ? "selected" : ""}`} aria-pressed={selected === item.id} onClick={() => { previewSequence.current++; setPlanning(false); setSelected(item.id); setPlan(null); setError(""); }}>
                  <span className={`cli-monogram ${item.id}`} aria-hidden="true">{initials[item.id]}</span><span><strong>{item.name}</strong><small>{working(progress[item.id]) ? t("正在处理…") : item.installed ? item.version || t("版本未知") : t("未安装")}</small></span><span className={`cli-presence ${item.installed ? "installed" : ""}`} aria-label={t(item.installed ? "已安装" : "未安装")} />
                </button>)}
              </div>
              {agent && <article className="cli-detail" key={agent.id} aria-label={t("{name} 管理", { name: agent.name })}>
                <div className="cli-detail-heading"><div><h2>{agent.name}</h2><p>{t(agent.description)}</p></div><button className="settings-text-button" onClick={() => void window.termbeacon.openCliDocs(agent.id).catch((cause) => setError(messageOf(cause)))}>{t("官方文档 ↗")}</button></div>
                <div className="cli-status-line"><span className={`cli-badge ${agent.source === "managed" ? "accent" : ""}`}>{t(sourceLabel[agent.source])}</span><span>{agent.version || t(agent.installed ? "未能读取版本" : "等待安装")}</span></div>
                {agent.error && <p className="cli-error">{t(agent.error)}</p>}
                <dl className="cli-facts"><div><dt>{t("启动路径")}</dt><dd>{agent.executable || t("尚未发现可执行文件")}</dd></div><div><dt>{t("托管安装包")}</dt><dd>{agent.package}</dd></div></dl>
                <div className="cli-actions">
                  {!agent.installed ? <button className="settings-button primary" disabled={disabled} onClick={() => void preview(agent.id, "install")}>{t("标准化安装")}</button> : <>
                    <button className="settings-button primary" disabled={disabled} onClick={() => void launch(agent.id)}>{t(launching ? "启动中…" : "在新终端启动")}</button>
                    <button className="settings-button" disabled={disabled} onClick={() => void preview(agent.id, agent.source === "managed" ? "update" : agent.managedInstalled ? "use-managed" : "install")}>{t(agent.source === "managed" ? "检查并更新" : agent.managedInstalled ? "使用托管安装" : "启用托管安装")}</button>
                  </>}
                </div>
                {planning && <p className="settings-status" role="status">{t("正在准备操作预览…")}</p>}
                {plan?.id === agent.id && <section className="cli-plan" aria-label={t("操作预览")}><h3>{t(plan.title)}{plan.packageVersion && <span> · {plan.packageVersion}</span>}</h3><ul>{plan.changes.map((change) => <li key={change}>{t(change)}</li>)}</ul>{plan.command && <code>{plan.command}</code>}<div className="cli-actions"><button className="settings-button primary" onClick={() => void execute()}>{t("确认并执行")}</button><button className="settings-button" onClick={() => setPlan(null)}>{t("取消")}</button></div></section>}
                {operation && <div className={`cli-operation ${operation.phase === "error" ? "error" : ""}`} role="status"><span className={working(operation) ? "cli-spinner" : ""} aria-hidden="true">{working(operation) ? "" : operation.phase === "done" ? "✓" : "!"}</span><span>{t(operation.message)}</span></div>}
                <section className="cli-integration"><div className="cli-section-heading"><h3>{t("状态检测")}</h3><span className="cli-badge">{t(agent.integration.label)}</span></div><p>{t(agent.signal)}</p><p className="settings-subtle">{t(agent.integration.detail)}</p>{agent.id === "opencode" && agent.integration.state !== "configured" && <p className="settings-subtle">{t("完成检测受限：缺少有效插件时，任务可能一直显示为工作中。")}</p>}{agent.id !== "codex" && <button className="settings-text-button" disabled={disabled || !agent.installed} onClick={() => void preview(agent.id, "integrate")}>{t(agent.integration.state === "configured" ? "修复状态接入" : "配置状态接入")} →</button>}</section>
                <details className="cli-advanced"><summary>{t("安装与环境详情")}</summary>
                  <dl className="cli-facts"><div><dt>{t("托管目录")}</dt><dd>{scan.root}</dd></div><div><dt>Node.js</dt><dd>{scan.runtime.nodeVersion || t("未找到")}{scan.runtime.node && <small>{scan.runtime.node}</small>}</dd></div>{agent.integration.path && <div><dt>{t("接入配置")}</dt><dd>{agent.integration.path}</dd></div>}{agent.externalPaths.length > 0 && <div><dt>{t("系统安装")}</dt><dd>{agent.externalPaths.map((file) => <small key={file}>{file}</small>)}</dd></div>}</dl>
                  <p className="settings-subtle">{t("托管安装位于当前用户目录。更新或重装验证通过后才切换入口，旧版本保留；现有终端需要重新打开才能使用新的 PATH。")}</p>
                  <div className="cli-actions"><button className="settings-button" disabled={disabled} onClick={() => void preview(agent.id, "reinstall")}>{t("标准化重装")}</button>{agent.source === "managed" && agent.previousVersion && <button className="settings-button" disabled={disabled} onClick={() => void preview(agent.id, "rollback")}>{t("回退到 {version}", { version: agent.previousVersion })}</button>}{agent.source === "managed" && agent.externalPaths.length > 0 && <button className="settings-button" disabled={disabled} onClick={() => void preview(agent.id, "use-system")}>{t("切回系统安装")}</button>}</div>
                </details>
                {!!logs[agent.id]?.length && <details className="cli-advanced"><summary>{t("操作日志")}</summary><pre className="cli-log">{logs[agent.id]?.map((line) => t(line)).join("\n")}</pre></details>}
              </article>}
            </div>
            <footer className="cli-scan-time">{t("本机检测于 {time} · 只使用当前用户权限", { time: new Date(scan.checkedAt).toLocaleTimeString(props.locale, { hour: "2-digit", minute: "2-digit" }) })}</footer>
          </>}
        </>}
      </div>
    </div>
  </section>;
}
