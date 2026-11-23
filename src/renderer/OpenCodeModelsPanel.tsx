import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OpenCodeModelEntry,
  OpenCodeModelsConfig,
  OpenCodeProviderDraft,
  OpenCodeProviderInfo,
} from "../shared/types";
import { settingsText, type SettingsLocale } from "./settings-i18n";

type Props = {
  locale: SettingsLocale;
  onLaunch: (id: "opencode") => Promise<void>;
};

type ModelRow = { id: string; name: string; modelID: string; disabled: boolean };

type ProviderDraft = {
  id: string;
  originalId?: string;
  name: string;
  baseURL: string;
  package: string;
  apiKey: string;
  apiKeyMode: "keep" | "set" | "clear";
  models: ModelRow[];
  credential: OpenCodeProviderInfo["credential"];
};

const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible";
const PACKAGE_OPTIONS = [
  DEFAULT_PACKAGE,
  "@opencode/ai/providers/openai-compatible/responses",
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/anthropic-compatible",
  "@opencode/ai/providers/anthropic",
  "@opencode/ai/providers/google",
  "@opencode/ai/providers/github-copilot",
  "@opencode/ai/providers/azure",
  "@opencode/ai/providers/amazon-bedrock",
];
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const messageOf = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
  : String(error);

function isLocalEndpoint(value: string) {
  if (!value.trim()) return false;
  try {
    const url = new URL(value.replace(/\{env:[^}]+\}/g, "localhost").replace(/\$\{[^}]+\}/g, "localhost"));
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
      || host.startsWith("192.168.") || host.startsWith("10.")
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
  } catch {
    return false;
  }
}

function emptyDraft(): ProviderDraft {
  return {
    id: "",
    name: "",
    baseURL: "",
    package: DEFAULT_PACKAGE,
    apiKey: "",
    apiKeyMode: "keep",
    models: [],
    credential: { kind: "none" },
  };
}

function draftFromProvider(provider: OpenCodeProviderInfo): ProviderDraft {
  return {
    id: provider.id,
    originalId: provider.id,
    name: provider.name === provider.id ? "" : provider.name,
    baseURL: provider.baseURL || "",
    package: provider.package || "",
    apiKey: "",
    apiKeyMode: "keep",
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name || "",
      modelID: model.modelID || "",
      disabled: model.disabled === true,
    })),
    credential: provider.credential,
  };
}

function toDraftModels(models: ModelRow[]): OpenCodeModelEntry[] {
  return models
    .map((model) => model.id.trim())
    .filter((id, index, list) => id && list.indexOf(id) === index)
    .map((id) => {
      const row = models.find((model) => model.id.trim() === id);
      return {
        id,
        ...(row?.name.trim() ? { name: row.name.trim() } : {}),
        ...(row?.modelID.trim() ? { modelID: row.modelID.trim() } : {}),
        ...(row?.disabled ? { disabled: true } : {}),
      };
    });
}

function credentialLabel(credential: OpenCodeProviderInfo["credential"], t: (source: string) => string) {
  if (credential.kind === "literal") return t("已设置密钥（明文）");
  if (credential.kind === "env") return t("使用环境变量：{value}").replace("{value}", credential.hint || "");
  if (credential.kind === "file") return t("使用文件：{value}").replace("{value}", credential.hint || "");
  return t("未设置密钥");
}

export default function OpenCodeModelsPanel({ locale, onLaunch: onLaunchOpenCode }: Props) {
  const t = (source: string, values?: Record<string, string | number>) => settingsText(locale, source, values);
  const [config, setConfig] = useState<OpenCodeModelsConfig | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "save" | "delete" | "discover" | "default" | "launch">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [defaultFilter, setDefaultFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [newModel, setNewModel] = useState("");
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discoverError, setDiscoverError] = useState("");
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const baseline = useRef("");
  const mounted = useRef(true);

  function setLoadedConfig(next: OpenCodeModelsConfig, preferredId?: string) {
    setConfig(next);
    const provider = next.providers.find((item) => item.id === preferredId)
      ?? next.providers[0]
      ?? null;
    if (provider) {
      const nextDraft = draftFromProvider(provider);
      setDraft(nextDraft);
      baseline.current = JSON.stringify(nextDraft);
    } else {
      setDraft(null);
      baseline.current = "";
    }
    setDiscovered(null);
    setDiscoverError("");
    setModelFilter("");
    setNewModel("");
  }

  async function reload(preferredId?: string, quiet = false) {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const next = await window.termbeacon.getOpenCodeModels();
      if (!mounted.current) return false;
      setLoadedConfig(next, preferredId);
      setNotice("");
      return true;
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
      return false;
    } finally {
      if (mounted.current && !quiet) setLoading(false);
    }
  }

  async function loadCatalog() {
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const result = await window.termbeacon.getOpenCodeModelCatalog();
      if (!mounted.current) return;
      if (!result.ok) {
        setCatalogError(result.error || t("未能读取 opencode 模型目录。"));
        return;
      }
      setCatalog(result.models);
    } catch (cause) {
      if (mounted.current) setCatalogError(messageOf(cause));
    } finally {
      if (mounted.current) setCatalogBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void reload();
    void loadCatalog();
    return () => { mounted.current = false; };
    // Load once when the panel opens; reloads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = Boolean(draft) && JSON.stringify(draft) !== baseline.current;

  async function confirmDiscard() {
    if (!dirty) return true;
    return window.termbeacon.confirm({
      message: t("当前服务商有未保存的更改，放弃这些更改？"),
      okLabel: t("放弃更改"),
      cancelLabel: t("取消"),
    });
  }

  async function reloadFromUi() {
    if (!(await confirmDiscard())) return;
    if (await reload(draft?.originalId) && mounted.current) setNotice(t("配置已重新加载。"));
  }

  async function chooseProvider(provider: OpenCodeProviderInfo) {
    if (!(await confirmDiscard())) return;
    const nextDraft = draftFromProvider(provider);
    setDraft(nextDraft);
    baseline.current = JSON.stringify(nextDraft);
    setError("");
    setNotice("");
    setDiscovered(null);
    setDiscoverError("");
    setModelFilter("");
  }

  async function startNewProvider() {
    if (!(await confirmDiscard())) return;
    const nextDraft = emptyDraft();
    setDraft(nextDraft);
    baseline.current = JSON.stringify(nextDraft);
    setError("");
    setNotice("");
    setDiscovered(null);
    setDiscoverError("");
    setModelFilter("");
    setDefaultFilter("");
  }

  function patchDraft(patch: Partial<ProviderDraft>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }

  function patchModel(id: string, patch: Partial<ModelRow>) {
    setDraft((current) => current
      ? { ...current, models: current.models.map((model) => model.id === id ? { ...model, ...patch } : model) }
      : current);
  }

  function removeModel(id: string) {
    setDraft((current) => current ? { ...current, models: current.models.filter((model) => model.id !== id) } : current);
  }

  function addModel() {
    const id = newModel.trim();
    if (!id || !draft) return;
    if (draft.models.some((model) => model.id === id)) {
      setNewModel("");
      return;
    }
    setDraft({ ...draft, models: [...draft.models, { id, name: "", modelID: "", disabled: false }] });
    setNewModel("");
  }

  function addDiscovered(models: string[]) {
    if (!draft) return;
    const known = new Set(draft.models.map((model) => model.id));
    const additions = models.filter((id) => !known.has(id)).map((id) => ({ id, name: "", modelID: "", disabled: false }));
    if (additions.length === 0) return;
    setDraft({ ...draft, models: [...draft.models, ...additions] });
    setNotice(t("已添加 {count} 个模型；保存服务商后生效。", { count: additions.length }));
  }

  async function saveProvider() {
    if (!draft) return;
    const id = draft.id.trim();
    if (!PROVIDER_ID.test(id)) {
      setError(t("服务商 ID 只能包含字母、数字、点、下划线和连字符，且不能以符号开头。"));
      return;
    }
    if (!draft.originalId && config?.providers.some((provider) => provider.id === id)) {
      setError(t("该服务商 ID 已存在。"));
      return;
    }
    const baseURL = draft.baseURL.trim();
    if (!draft.originalId && !baseURL) {
      setError(t("请填写 Base URL。"));
      return;
    }
    if (baseURL && !/^https?:\/\//i.test(baseURL) && !/\{(?:env|file):[^}]+\}/.test(baseURL) && !/\$\{[^}]+\}/.test(baseURL)) {
      setError(t("Base URL 必须以 http:// 或 https:// 开头。"));
      return;
    }
    const payload: OpenCodeProviderDraft = {
      id,
      ...(draft.originalId ? { originalId: draft.originalId } : {}),
      name: draft.name.trim(),
      baseURL,
      package: draft.package.trim(),
      apiKeyMode: draft.apiKey.trim() ? "set" : draft.apiKeyMode,
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      models: toDraftModels(draft.models),
    };
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const result = await window.termbeacon.saveOpenCodeProvider(payload);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.error || t("保存服务商失败。"));
        return;
      }
      setLoadedConfig(result.config, id);
      setNotice(t("已保存。新启动的 opencode 终端会使用此配置。"));
      void loadCatalog();
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function deleteProvider() {
    if (!draft?.originalId) return;
    const confirmed = await window.termbeacon.confirm({
      message: t("删除服务商「{name}」？这会从 opencode 配置中移除它的模型列表。", { name: draft.name || draft.id }),
      okLabel: t("删除服务商"),
      cancelLabel: t("取消"),
    });
    if (!confirmed) return;
    setBusy("delete");
    setError("");
    setNotice("");
    try {
      const result = await window.termbeacon.deleteOpenCodeProvider(draft.originalId);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.error || t("删除服务商失败。"));
        return;
      }
      setLoadedConfig(result.config);
      setNotice(result.clearedDefault ? t("已删除服务商，并清除了指向它的默认模型。") : t("已删除服务商。"));
      void loadCatalog();
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function discoverModels() {
    if (!draft) return;
    if (!draft.baseURL.trim()) {
      setDiscoverError(t("请先填写 Base URL。"));
      return;
    }
    setBusy("discover");
    setDiscoverError("");
    setNotice("");
    try {
      const result = await window.termbeacon.discoverOpenCodeModels({
        baseURL: draft.baseURL.trim(),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.originalId ? { providerId: draft.originalId } : {}),
        ...(draft.apiKeyMode === "clear" ? { useStoredKey: false } : {}),
      });
      if (!mounted.current) return;
      if (!result.ok) {
        setDiscoverError(result.error || t("未获取到模型。"));
        return;
      }
      setDiscovered(result.models);
      if (result.models.length === 0) setDiscoverError(t("服务没有返回模型。"));
    } catch (cause) {
      if (mounted.current) setDiscoverError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function chooseDefault(model: string | null) {
    setBusy("default");
    setError("");
    setNotice("");
    try {
      const result = await window.termbeacon.setOpenCodeDefaultModel(model);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.error || t("保存默认模型失败。"));
        return;
      }
      setConfig(result.config);
      setNotice(model ? t("默认模型已切换为 {model}。", { model }) : t("已清除默认模型。"));
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function openConfigFolder() {
    try {
      const result = await window.termbeacon.openOpenCodeModelsConfig();
      if (!result.ok) setError(result.message || t("无法打开配置目录。"));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function launchOpenCode() {
    setBusy("launch");
    setError("");
    try {
      await onLaunchOpenCode("opencode");
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  const allModels = useMemo(() => {
    if (!config) return [];
    const configured = config.providers.flatMap((provider) => provider.models
      .filter((model) => !model.disabled)
      .map((model) => ({
        value: `${provider.id}/${model.id}`,
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        label: model.name || model.id,
        source: "config" as const,
      })));
    const known = new Set(configured.map((model) => model.value));
    const available = catalog
      .filter((value) => !known.has(value))
      .map((value) => {
        const slash = value.indexOf("/");
        const providerId = value.slice(0, slash);
        const modelId = value.slice(slash + 1);
        return {
          value,
          providerId,
          providerName: providerId,
          modelId,
          label: modelId,
          source: "catalog" as const,
        };
      });
    return [...configured, ...available].sort((left, right) =>
      left.providerName.localeCompare(right.providerName) || left.modelId.localeCompare(right.modelId));
  }, [config, catalog]);
  const filteredModels = allModels.filter((model) => {
    const query = defaultFilter.trim().toLowerCase();
    if (!query) return true;
    return `${model.label} ${model.value} ${model.providerName}`.toLowerCase().includes(query);
  });
  const currentInList = Boolean(config?.model && allModels.some((model) => model.value === config.model));
  const visibleDraftModels = draft?.models.filter((model) => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return true;
    return `${model.id} ${model.name} ${model.modelID}`.toLowerCase().includes(query);
  }) ?? [];
  const localEndpoint = isLocalEndpoint(draft?.baseURL || "");
  const canClearKey = Boolean(draft?.originalId && draft.credential.kind !== "none");
  const isNew = Boolean(draft && !draft.originalId);

  return <div className="opencode-models">
    <div className="models-pathbar">
      <div><span className="models-path-label">{t("全局配置")}</span><code title={config?.path}>{config?.path || t("读取中…")}</code></div>
      <div className="models-path-actions">
        {config && <span className="cli-badge">{config.key === "providers" ? "providers" : t("旧版 provider 格式")}</span>}
        <button className="settings-text-button" onClick={() => void openConfigFolder()}>{t("打开配置目录")}</button>
        <button className="settings-text-button" disabled={loading || busy !== ""} onClick={() => void reloadFromUi()}>{t("重新加载")}</button>
      </div>
    </div>

    {config?.error && <div className="settings-notice error" role="alert"><span>{t(config.error)}</span></div>}
    {!!config?.warnings.length && <div className="settings-notice">{config.warnings.map((warning) => <span key={warning}>{t(warning)}</span>)}</div>}
    {error && <div className="settings-notice error" role="alert"><span>{t(error)}</span><button onClick={() => setError("")} aria-label={t("关闭提示")}>×</button></div>}
    {notice && <div className="settings-notice" role="status"><span>{t(notice)}</span><button onClick={() => setNotice("")} aria-label={t("关闭提示")}>×</button></div>}

    {!config && loading && <div className="settings-empty" role="status">{t("正在读取 opencode 配置…")}</div>}

    {config && !config.error && <>
      <section className="models-default-card" aria-labelledby="models-default-heading">
        <div className="models-section-heading">
          <div>
            <h2 id="models-default-heading">{t("默认模型")}</h2>
            <p>{t("点击一个模型即可设为新启动的 opencode 会话默认使用的模型。")}</p>
          </div>
          <div className="models-default-actions">
            {config.model && <span className="models-current" title={config.model}>{t("当前：{model}", { model: config.model })}</span>}
            {config.model && <button className="settings-text-button" disabled={busy !== ""} onClick={() => void chooseDefault(null)}>{t("清除默认模型")}</button>}
            <button className="settings-text-button" disabled={busy !== "" || catalogBusy} onClick={() => void loadCatalog()}>{t(catalogBusy ? "正在读取模型…" : "刷新可用模型")}</button>
            <button className="settings-button" disabled={busy !== ""} onClick={() => void launchOpenCode()}>{t(busy === "launch" ? "启动中…" : "在新终端启动 opencode")}</button>
          </div>
        </div>
        {catalogError && <p className="settings-subtle models-error">{t("读取 opencode 模型目录失败：{message}", { message: t(catalogError) })}</p>}
        {allModels.length > 0 ? <>
          <input className="models-search" value={defaultFilter} onChange={(event) => setDefaultFilter(event.target.value)} placeholder={t("搜索模型")} aria-label={t("搜索模型")} />
          {catalog.length > 0 && <p className="settings-subtle">{t("从 opencode 模型目录读取到 {count} 个可用模型。", { count: catalog.length })}</p>}
          <div className="models-choice-grid">
            {filteredModels.map((model) => <button key={model.value} className={`models-choice ${config.model === model.value ? "selected" : ""}`} disabled={busy !== ""} onClick={() => void chooseDefault(model.value)}>
              <span className="models-choice-name">{model.label}</span>
              <span className="models-choice-meta">{model.providerName} · {model.modelId}{model.source === "catalog" ? ` · ${t("模型目录")}` : ""}</span>
              <span className="models-choice-check" aria-hidden="true">{config.model === model.value ? "✓" : ""}</span>
            </button>)}
            {filteredModels.length === 0 && <p className="settings-subtle">{t("没有匹配的模型。")}</p>}
          </div>
          {config.model && !currentInList && <p className="settings-subtle">{t("当前默认模型不在已配置的列表中：{model}。", { model: config.model })}</p>}
        </> : <p className="settings-subtle">{t("还没有配置模型。添加服务商和模型后即可在这里选择。")}</p>}
      </section>

      <div className="models-layout">
        <aside className="models-provider-list" aria-label={t("模型服务商")}>
          <div className="models-list-heading"><h2>{t("服务商")}</h2><button className="settings-text-button" disabled={busy !== ""} onClick={() => void startNewProvider()}>+ {t("添加服务商")}</button></div>
          {config.providers.map((provider) => <button key={provider.id} className={`models-provider-item ${draft?.originalId === provider.id ? "selected" : ""}`} aria-pressed={draft?.originalId === provider.id} onClick={() => void chooseProvider(provider)}>
            <strong>{provider.name}</strong>
            <small>{provider.baseURL || t("使用内置目录")}</small>
            <span>{t("{count} 个模型", { count: provider.models.length })}{provider.credential.kind !== "none" ? " · 🔑" : ""}</span>
          </button>)}
          {config.providers.length === 0 && <p className="settings-subtle">{t("还没有服务商。点击“添加服务商”开始配置。")}</p>}
        </aside>

        <section className="models-detail" aria-label={isNew ? t("添加服务商") : t("编辑服务商")}>
          {draft ? <>
            <div className="models-detail-heading">
              <div><h2>{isNew ? t("添加服务商") : (draft.name || draft.id)}</h2><p>{isNew ? t("填写一个 OpenAI 兼容服务；本地地址可以留空 API Key。") : t("修改后保存，新启动的 opencode 终端生效。")}</p></div>
              {draft.credential.kind !== "none" && <span className="cli-badge accent">{credentialLabel(draft.credential, t)}</span>}
            </div>

            <div className="models-form-grid">
              <label className="models-field"><span>{t("服务商 ID")}</span><input value={draft.id} disabled={!isNew} spellCheck={false} placeholder="my-gateway" onChange={(event) => { const id = event.target.value; patchDraft({ id, ...(isNew ? { name: draft.name || id } : {}) }); }} /><small>{isNew ? t("用于模型引用，例如 my-gateway/model-id。只能包含字母、数字、点、下划线和连字符。") : t("服务商 ID 创建后不可修改。")}</small></label>
              <label className="models-field"><span>{t("显示名称")}</span><input value={draft.name} placeholder={draft.id || t("可选")} onChange={(event) => patchDraft({ name: event.target.value })} /></label>
              <label className="models-field models-field-wide"><span>Base URL</span><input value={draft.baseURL} spellCheck={false} placeholder="http://127.0.0.1:11434/v1" onChange={(event) => patchDraft({ baseURL: event.target.value })} />{localEndpoint ? <small>{t("本地地址，通常无需 API Key。")}</small> : <small>{t("OpenAI 兼容接口通常以 /v1 结尾。")}</small>}</label>
              <label className="models-field models-field-wide"><span>API Key</span><input type="password" autoComplete="new-password" value={draft.apiKey} placeholder={draft.credential.kind !== "none" && draft.apiKeyMode !== "clear" ? t("留空保持不变") : t("本地地址可留空")} onChange={(event) => { const value = event.target.value; patchDraft({ apiKey: value, apiKeyMode: value ? "set" : (draft.apiKeyMode === "set" ? (canClearKey ? "keep" : "keep") : draft.apiKeyMode) }); }} /><small>{draft.apiKeyMode === "clear" ? t("保存后将清除当前密钥。") : draft.apiKey ? t("保存后将替换当前密钥。") : credentialLabel(draft.credential, t)}</small></label>
              <label className="models-field models-field-wide"><span>{t("运行时包")}</span><input list="opencode-model-packages" value={draft.package} spellCheck={false} placeholder={t("留空使用内置目录；自定义服务填写运行时包")} onChange={(event) => patchDraft({ package: event.target.value })} /><datalist id="opencode-model-packages">{PACKAGE_OPTIONS.map((item) => <option key={item} value={item} />)}</datalist><small>{t("自定义 OpenAI 兼容服务通常使用默认的 openai-compatible 包。")}</small></label>
            </div>

            {canClearKey && <div className="models-key-actions">{draft.apiKeyMode === "clear" ? <><span>{t("保存后将清除密钥。")}</span><button className="settings-text-button" onClick={() => patchDraft({ apiKeyMode: "keep" })}>{t("撤销清除")}</button></> : <button className="settings-text-button" onClick={() => patchDraft({ apiKeyMode: "clear", apiKey: "" })}>{t("清除已保存的密钥")}</button>}</div>}

            <section className="models-model-section" aria-labelledby="models-list-heading">
              <div className="models-section-heading">
                <div><h3 id="models-list-heading">{t("模型")} <span className="settings-version">{t("{count} 个", { count: draft.models.length })}</span></h3><p>{t("添加模型 ID，或从服务端读取列表后勾选。")}</p></div>
                <button className="settings-button" disabled={busy !== "" || !draft.baseURL.trim()} onClick={() => void discoverModels()}>{t(busy === "discover" ? "正在获取…" : "从服务获取模型")}</button>
              </div>
              <div className="models-add-row">
                <input value={newModel} placeholder={t("输入模型 ID，例如 deepseek-chat")} onChange={(event) => setNewModel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel(); } }} />
                <button className="settings-button" disabled={!newModel.trim()} onClick={addModel}>{t("添加模型")}</button>
              </div>
              {discoverError && <p className="settings-subtle models-error">{t(discoverError)}</p>}
              {discovered && <div className="models-discovered">
                <div className="models-discovered-heading"><span>{t("服务端返回 {count} 个模型", { count: discovered.length })}</span><button className="settings-text-button" onClick={() => addDiscovered(discovered)}>{t("全部添加")}</button></div>
                <div className="models-discovered-list">{discovered.map((id) => <button key={id} className="settings-text-button" disabled={draft.models.some((model) => model.id === id)} onClick={() => addDiscovered([id])}>{draft.models.some((model) => model.id === id) ? `✓ ${id}` : `+ ${id}`}</button>)}</div>
              </div>}
              {draft.models.length > 0 && <input className="models-search" value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} placeholder={t("筛选模型")} aria-label={t("筛选模型")} />}
              <div className="models-model-list">
                {visibleDraftModels.map((model) => <div className="models-model-row" key={model.id}>
                  <span className="models-model-id" title={model.id}>{model.id}{model.modelID && <small>→ {model.modelID}</small>}</span>
                  <input value={model.name} placeholder={t("显示名称（可选）")} aria-label={t("显示名称（可选）")} onChange={(event) => patchModel(model.id, { name: event.target.value })} />
                  <label className="models-model-disabled"><input type="checkbox" checked={model.disabled} onChange={(event) => patchModel(model.id, { disabled: event.target.checked })} />{t("隐藏")}</label>
                  <button className="models-remove" onClick={() => removeModel(model.id)} aria-label={t("删除模型 {id}", { id: model.id })} title={t("删除模型")}>×</button>
                </div>)}
                {draft.models.length === 0 && <p className="settings-subtle">{t("还没有模型。可以从服务获取，也可以手动添加。")}</p>}
                {draft.models.length > 0 && visibleDraftModels.length === 0 && <p className="settings-subtle">{t("没有匹配的模型。")}</p>}
              </div>
            </section>

            <div className="models-form-footer">
              <div className="models-form-actions">
                {draft.originalId && <button className="settings-button danger" disabled={busy !== ""} onClick={() => void deleteProvider()}>{t("删除服务商")}</button>}
                <button className="settings-button primary" disabled={busy !== ""} onClick={() => void saveProvider()}>{t(busy === "save" ? "保存中…" : isNew ? "添加服务商" : "保存服务商")}</button>
                {dirty && <button className="settings-text-button" onClick={() => { if (draft.originalId && config) { const original = config.providers.find((item) => item.id === draft.originalId); if (original) { const reset = draftFromProvider(original); setDraft(reset); baseline.current = JSON.stringify(reset); } } else { const reset = emptyDraft(); setDraft(reset); baseline.current = JSON.stringify(reset); } }}>{t("取消更改")}</button>}
              </div>
              {dirty && <span className="settings-status">{t("有未保存的更改")}</span>}
            </div>
          </> : <div className="models-empty"><p>{t("还没有服务商。")}</p><button className="settings-button primary" onClick={() => void startNewProvider()}>{t("添加服务商")}</button></div>}
        </section>
      </div>

      <footer className="models-footer">
        <p>{t("保存后写入 opencode 全局配置；新启动的 opencode 终端会读取它。已运行的终端需要重启才能使用新模型。")}</p>
        <p>{t("项目目录内的 opencode.json(c) 仍可能覆盖全局设置。保存前会自动备份原文件，TermBeacon 保留最近 5 份。")}</p>
        <p>{t("API 密钥会以明文保存在 opencode 配置中；也可以填写 {env:变量名} 或 {file:路径} 引用。")}</p>
        {config.key === "provider" && <p>{t("当前配置使用旧版 provider 格式，TermBeacon 会按该格式写回。")}</p>}
      </footer>
    </>}
  </div>;
}
