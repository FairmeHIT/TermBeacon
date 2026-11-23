// Visual model/provider management for opencode's global configuration.
//
// opencode accepts JSONC, so a naive JSON.stringify would destroy comments,
// trailing commas and key order in a hand-maintained file. This module keeps
// the original document and only replaces the top-level values it owns
// (`providers`/`provider`, `model`, `small_model`), preserving everything else.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveConfigDir } = require("./opencode-theme.cjs");

const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible";
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID_LIMIT = 200;
const MAX_MODELS = 500;
const CONFIG_SCHEMA = "https://opencode.ai/config.json";
const BACKUP_KEEP = 5;
const DISCOVERY_TIMEOUT_MS = 20_000;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value, limit = 2048) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, limit) : undefined;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripComments(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        out += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        out += char;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function stripTrailingCommas(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    out += char;
  }
  return out;
}

// Full JSONC parse used for validation and for reading the document. Comments
// and trailing commas are the only extensions; anything else stays a parse
// error so a broken config is never silently rewritten.
function parseJsonc(source) {
  return JSON.parse(stripTrailingCommas(stripComments(stripBom(String(source ?? "")))));
}

function skipWhitespaceAndComments(source, index) {
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      cursor += 1;
      continue;
    }
    if (char === "/" && source[cursor + 1] === "/") {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") cursor += 1;
      continue;
    }
    if (char === "/" && source[cursor + 1] === "*") {
      cursor += 2;
      while (cursor < source.length && !(source[cursor] === "*" && source[cursor + 1] === "/")) cursor += 1;
      cursor = Math.min(source.length, cursor + 2);
      continue;
    }
    break;
  }
  return cursor;
}

function scanString(source, start) {
  let cursor = start + 1;
  let escaped = false;
  while (cursor < source.length) {
    const char = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  throw new Error("字符串没有结束引号");
}

function scanValue(source, start) {
  const first = source[start];
  if (first === '"') return scanString(source, start);
  if (first === "{" || first === "[") {
    let depth = 0;
    let cursor = start;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '"') {
        cursor = scanString(source, cursor);
        continue;
      }
      if (char === "/" && source[cursor + 1] === "/") {
        cursor = skipWhitespaceAndComments(source, cursor);
        continue;
      }
      if (char === "/" && source[cursor + 1] === "*") {
        cursor = skipWhitespaceAndComments(source, cursor);
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        cursor += 1;
        if (depth === 0) return cursor;
        continue;
      }
      cursor += 1;
    }
    throw new Error("对象或数组没有结束");
  }
  let cursor = start;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "," || char === "}" || char === "]") break;
    if (char === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) break;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") break;
    cursor += 1;
  }
  if (cursor === start) throw new Error("缺少配置值");
  return cursor;
}

// Top-level member spans let us replace one value without touching the rest of
// the file. Nested braces, strings and comments are scanned, not parsed.
function scanTopLevelObject(source) {
  let cursor = skipWhitespaceAndComments(source, 0);
  if (source[cursor] !== "{") throw new Error("配置文件顶层必须是 JSON 对象");
  const openBrace = cursor;
  cursor += 1;
  const members = [];
  for (;;) {
    cursor = skipWhitespaceAndComments(source, cursor);
    if (cursor >= source.length) throw new Error("配置对象没有结束");
    if (source[cursor] === "}") return { openBrace, closeBrace: cursor, members };
    if (source[cursor] === ",") {
      cursor += 1;
      continue;
    }
    const keyStart = cursor;
    if (source[cursor] !== '"') throw new Error("配置键必须是字符串");
    const keyEnd = scanString(source, cursor);
    let key;
    try {
      key = JSON.parse(source.slice(keyStart, keyEnd));
    } catch {
      throw new Error("配置键无法解析");
    }
    cursor = skipWhitespaceAndComments(source, keyEnd);
    if (source[cursor] !== ":") throw new Error(`配置键 “${key}” 后缺少冒号`);
    cursor = skipWhitespaceAndComments(source, cursor + 1);
    const valueStart = cursor;
    const valueEnd = scanValue(source, cursor);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    cursor = valueEnd;
  }
}

function newlineStyle(source) {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function lineIndent(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const prefix = source.slice(lineStart, index);
  return /^[ \t]*$/.test(prefix) ? prefix : "  ";
}

function renderValue(value, indent, newline) {
  return JSON.stringify(value, null, 2).split("\n").join(newline + indent);
}

function setTopLevelValue(source, key, value) {
  const { openBrace, closeBrace, members } = scanTopLevelObject(source);
  const newline = newlineStyle(source);
  const existing = members.find((member) => member.key === key);
  if (existing) {
    const indent = lineIndent(source, existing.keyStart);
    const rendered = renderValue(value, indent, newline);
    return source.slice(0, existing.valueStart) + rendered + source.slice(existing.valueEnd);
  }
  const indent = members.length > 0 ? lineIndent(source, members[0].keyStart) : "  ";
  const rendered = renderValue(value, indent, newline);
  if (members.length === 0) {
    const inside = source.slice(openBrace + 1, closeBrace);
    if (!inside.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "").trim()) {
      if (!inside.includes("\n")) {
        return `${source.slice(0, openBrace)}{\n${indent}"${key}": ${rendered}\n${source.slice(closeBrace)}`;
      }
      return `${source.slice(0, openBrace + 1)}${newline}${indent}"${key}": ${rendered}${source.slice(openBrace + 1)}`;
    }
    return `${source.slice(0, openBrace + 1)}${newline}${indent}"${key}": ${rendered}${source.slice(openBrace + 1)}`;
  }
  const last = members[members.length - 1];
  const afterValue = skipWhitespaceAndComments(source, last.valueEnd);
  const hasTrailingComma = source[afterValue] === ",";
  const insertAt = hasTrailingComma ? afterValue + 1 : last.valueEnd;
  const multiline = source.slice(openBrace, closeBrace).includes("\n");
  const separator = multiline ? newline : " ";
  const comma = hasTrailingComma ? "" : ",";
  return `${source.slice(0, insertAt)}${comma}${separator}${indent}"${key}": ${rendered}${source.slice(insertAt)}`;
}

function removeTopLevelValue(source, key) {
  const { openBrace, closeBrace, members } = scanTopLevelObject(source);
  const index = members.findIndex((member) => member.key === key);
  if (index < 0) return source;
  const member = members[index];
  const keyLineStart = source.lastIndexOf("\n", member.keyStart - 1) + 1;
  const keyOwnsLine = keyLineStart > 0 && /^[ \t]*$/.test(source.slice(keyLineStart, member.keyStart));
  if (index < members.length - 1) {
    const next = members[index + 1];
    const nextLineStart = source.lastIndexOf("\n", next.keyStart - 1) + 1;
    const nextOwnsLine = nextLineStart > 0 && /^[ \t]*$/.test(source.slice(nextLineStart, next.keyStart));
    return source.slice(0, keyOwnsLine ? keyLineStart : member.keyStart)
      + source.slice(nextOwnsLine ? nextLineStart : next.keyStart);
  }
  let end = member.valueEnd;
  const afterMember = skipWhitespaceAndComments(source, member.valueEnd);
  if (source[afterMember] === ",") end = afterMember + 1;
  if (index > 0) {
    const previous = members[index - 1];
    const afterPrevious = skipWhitespaceAndComments(source, previous.valueEnd);
    const start = source[afterPrevious] === "," ? afterPrevious : previous.valueEnd;
    return source.slice(0, start) + source.slice(end);
  }
  if (keyOwnsLine) return source.slice(0, keyLineStart) + source.slice(end);
  return source.slice(0, openBrace + 1) + source.slice(closeBrace);
}

function credentialInfo(apiKey, envList) {
  if (typeof apiKey === "string" && apiKey.trim()) {
    if (/^\{env:[^}]+\}$/.test(apiKey.trim()) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(apiKey.trim())) {
      return { hasApiKey: true, kind: "env", hint: apiKey.trim() };
    }
    if (/^\{file:[^}]+\}$/.test(apiKey.trim())) {
      return { hasApiKey: true, kind: "file", hint: apiKey.trim() };
    }
    return { hasApiKey: true, kind: "literal" };
  }
  if (Array.isArray(envList) && envList.some((item) => typeof item === "string" && item.trim())) {
    return { hasApiKey: true, kind: "env", hint: envList.filter((item) => typeof item === "string" && item.trim()).join(", ") };
  }
  return { hasApiKey: false, kind: "none" };
}

function modelRef(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isObject(value) && typeof value.providerID === "string" && typeof value.model === "string") {
    const variant = typeof value.variant === "string" && value.variant ? `#${value.variant}` : "";
    return `${value.providerID}/${value.model}${variant}`;
  }
  return undefined;
}

function readProvider(id, value, legacy) {
  const entry = isObject(value) ? value : {};
  const settings = isObject(entry.settings) ? entry.settings : undefined;
  const options = isObject(entry.options) ? entry.options : undefined;
  const baseURL = textValue(settings?.baseURL) || textValue(options?.baseURL) || textValue(entry.baseURL);
  const apiKey = textValue(settings?.apiKey, 4096) || textValue(options?.apiKey, 4096);
  const packageName = legacy
    ? textValue(entry.npm, 300) || textValue(entry.package, 300)
    : textValue(entry.package, 300) || textValue(entry.npm, 300);
  const models = [];
  if (isObject(entry.models)) {
    for (const [modelId, modelValue] of Object.entries(entry.models)) {
      const model = isObject(modelValue) ? modelValue : {};
      const name = textValue(model.name, 200);
      let modelID = textValue(model.modelID, MODEL_ID_LIMIT);
      if (!modelID && legacy) {
        const legacyId = textValue(model.id, MODEL_ID_LIMIT);
        if (legacyId && legacyId !== modelId) modelID = legacyId;
      }
      models.push({
        id: modelId,
        ...(name ? { name } : {}),
        ...(modelID ? { modelID } : {}),
        ...(model.disabled === true ? { disabled: true } : {}),
      });
    }
  }
  return {
    id,
    name: textValue(entry.name, 200) || id,
    ...(baseURL ? { baseURL } : {}),
    ...(packageName ? { package: packageName } : {}),
    models,
    credential: credentialInfo(apiKey, entry.env),
  };
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const result = [];
  for (const item of models) {
    const id = textValue(typeof item === "string" ? item : item?.id, MODEL_ID_LIMIT);
    if (!id || seen.has(id) || /[\u0000-\u001f\u007f#]/.test(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: textValue(item?.name, 200),
      modelID: textValue(item?.modelID, MODEL_ID_LIMIT),
      ...(item?.disabled === true ? { disabled: true } : {}),
    });
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}

function mergeModels(existing, requested, legacy) {
  const source = isObject(existing) ? existing : {};
  const next = Object.create(null);
  for (const item of requested) {
    const base = isObject(source[item.id]) ? { ...source[item.id] } : {};
    if (item.name !== undefined) {
      if (item.name) base.name = item.name;
      else delete base.name;
    }
    if (item.modelID !== undefined) {
      if (legacy) {
        if (item.modelID) base.id = item.modelID;
        else delete base.id;
      } else if (item.modelID) {
        base.modelID = item.modelID;
      } else {
        delete base.modelID;
      }
    }
    if (item.disabled === true) base.disabled = true;
    else delete base.disabled;
    next[item.id] = base;
  }
  return next;
}

function modelCandidates(baseURL) {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (/\/models$/i.test(trimmed)) return [trimmed];
  const pathname = (() => {
    try { return new URL(trimmed).pathname.replace(/\/+$/, ""); } catch { return ""; }
  })();
  if (/\/v1$/i.test(pathname)) return [`${trimmed}/models`];
  return [`${trimmed}/models`, `${trimmed}/v1/models`, `${trimmed}/api/tags`];
}

function parseModelList(payload) {
  const items = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.data)
      ? payload.data
      : isObject(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const id = textValue(typeof item === "string" ? item : item?.id ?? item?.name ?? item?.model, MODEL_ID_LIMIT);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models.sort((left, right) => left.localeCompare(right));
}

function shortError(payload, fallback) {
  if (isObject(payload)) {
    const detail = textValue(payload.error?.message, 300) || textValue(payload.error, 300) || textValue(payload.message, 300);
    if (detail) return detail;
  }
  return fallback;
}

function backupName(target) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`;
  return `${target}.bak-termbeacon-${stamp}`;
}

function pruneBackups(target) {
  try {
    const directory = path.dirname(target);
    const prefix = `${path.basename(target)}.bak-termbeacon-`;
    const entries = fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, at: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at);
    for (const entry of entries.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(directory, entry.name)); } catch { /* best effort */ }
    }
  } catch { /* backup prunes are cosmetic */ }
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, content, "utf8");
  try {
    fs.renameSync(temporary, target);
  } catch {
    try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
    fs.renameSync(temporary, target);
  }
}

function createOpenCodeModelsStore({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  listModels,
} = {}) {
  function resolveTarget() {
    const directory = resolveConfigDir({ home, env });
    const jsonc = path.join(directory, "opencode.jsonc");
    const json = path.join(directory, "opencode.json");
    const hasJsonc = fs.existsSync(jsonc);
    const hasJson = fs.existsSync(json);
    const sizeOf = (file) => {
      try { return fs.statSync(file).size; } catch { return -1; }
    };
    const warnings = [];
    if (hasJsonc && hasJson) {
      const useJsonc = sizeOf(jsonc) > 0 || sizeOf(json) <= 0;
      warnings.push(`同时存在 opencode.jsonc 与 opencode.json，TermBeacon 将编辑 ${useJsonc ? "opencode.jsonc" : "opencode.json"}。`);
      return { path: useJsonc ? jsonc : json, directory, warnings };
    }
    return { path: hasJson ? json : jsonc, directory, warnings };
  }

  function resolveConfigPath() {
    return resolveTarget().path;
  }

  function readDocument() {
    const target = resolveTarget();
    let raw = "";
    let exists = true;
    try {
      raw = fs.readFileSync(target.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw Object.assign(new Error(`无法读取 opencode 配置：${error.message}`), { configPath: target.path, warnings: target.warnings });
      }
      exists = false;
    }
    const bom = raw.startsWith("\uFEFF");
    const text = bom ? raw.slice(1) : raw;
    if (!exists || !text.trim()) {
      return { ...target, exists, bom, raw, text, data: null, key: "providers" };
    }
    let data;
    try {
      data = parseJsonc(text);
    } catch (error) {
      throw Object.assign(new Error(`配置文件无法解析：${error.message}`), { configPath: target.path, warnings: target.warnings });
    }
    if (!isObject(data)) {
      throw Object.assign(new Error("配置文件顶层必须是 JSON 对象"), { configPath: target.path, warnings: target.warnings });
    }
    return {
      ...target,
      exists,
      bom,
      raw,
      text,
      data,
      key: isObject(data.providers) ? "providers" : isObject(data.provider) ? "provider" : "providers",
    };
  }

  function snapshot(document = readDocument()) {
    const data = isObject(document.data) ? document.data : {};
    const providersValue = isObject(data[document.key]) ? data[document.key] : {};
    const providers = Object.entries(providersValue)
      .filter(([id, value]) => typeof id === "string" && isObject(value))
      .map(([id, value]) => readProvider(id, value, document.key === "provider"));
    const warnings = [...(document.warnings || [])];
    if (document.key === "provider" && isObject(data.providers)) {
      warnings.push("配置文件同时包含 providers 与旧版 provider；TermBeacon 当前编辑旧版 provider。");
    }
    return {
      ok: true,
      path: document.path,
      directory: document.directory,
      exists: document.exists,
      format: document.path.endsWith(".jsonc") ? "jsonc" : "json",
      key: document.key,
      providers,
      ...(modelRef(data.model) ? { model: modelRef(data.model) } : {}),
      ...(textValue(data.small_model, 300) ? { smallModel: textValue(data.small_model, 300) } : {}),
      warnings,
    };
  }

  function load() {
    const target = resolveTarget();
    try {
      return snapshot();
    } catch (error) {
      return {
        ok: false,
        path: error.configPath || target.path,
        directory: target.directory,
        exists: fs.existsSync(error.configPath || target.path),
        format: (error.configPath || target.path).endsWith(".jsonc") ? "jsonc" : "json",
        key: "providers",
        providers: [],
        warnings: error.warnings || target.warnings,
        error: error.message,
      };
    }
  }

  function writeUpdates(document, updates) {
    const newline = newlineStyle(document.text);
    let text = document.text;
    if (!text.trim()) {
      const initial = { $schema: CONFIG_SCHEMA };
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === null) continue;
        initial[key] = value;
      }
      text = `${JSON.stringify(initial, null, 2).replace(/\n/g, newline)}${newline}`;
    } else {
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) continue;
        if (value === null) text = removeTopLevelValue(text, key);
        else text = setTopLevelValue(text, key, value);
      }
    }
    try {
      const parsed = parseJsonc(text);
      if (!isObject(parsed)) throw new Error("配置文件顶层必须是 JSON 对象");
    } catch (error) {
      throw new Error(`修改后的配置无法解析：${error.message}`);
    }
    if (text === document.text) return { backup: undefined, changed: false };
    let backup;
    if (document.text.trim()) {
      backup = backupName(document.path);
      fs.copyFileSync(document.path, backup);
      pruneBackups(document.path);
    }
    writeFileAtomic(document.path, `${document.bom ? "\uFEFF" : ""}${text}`);
    return { backup, changed: true };
  }

  function failure(error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), changed: false, config: load() };
  }

  function saveProvider(draft) {
    try {
      if (!isObject(draft)) throw new Error("服务商数据无效");
      const document = readDocument();
      if (!isObject(document.data)) document.data = { schemaVersion: 1 };
      const providers = Object.assign(Object.create(null), isObject(document.data[document.key]) ? document.data[document.key] : {});
      const legacy = document.key === "provider";
      const id = textValue(draft.id, 64);
      if (!id || !PROVIDER_ID_PATTERN.test(id)) {
        throw new Error("服务商 ID 只能包含字母、数字、点、下划线和连字符，且必须以字母或数字开头");
      }
      const originalId = textValue(draft.originalId, 64);
      const existingId = originalId && providers[originalId]
        ? originalId
        : providers[id] ? id : undefined;
      if (originalId && !providers[originalId]) throw new Error("要编辑的服务商已不存在，请重新加载");
      if (!existingId && providers[id]) throw new Error(`服务商 ${id} 已存在`);
      if (existingId && existingId !== id && providers[id]) throw new Error(`服务商 ${id} 已存在`);
      const name = textValue(draft.name, 200);
      if (draft.name !== undefined && typeof draft.name !== "string") throw new Error("显示名称无效");
      const baseURL = draft.baseURL === undefined ? undefined : textValue(draft.baseURL, 4096);
      if (baseURL && !/\{(?:env|file):[^}]+\}/.test(baseURL) && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(baseURL)) {
        let url;
        try { url = new URL(baseURL); } catch { throw new Error("Base URL 无效"); }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 只支持 http 或 https");
      }
      const packageName = draft.package === undefined ? undefined : textValue(draft.package, 300);
      if (draft.package !== undefined && typeof draft.package !== "string") throw new Error("运行时包无效");
      const apiKeyMode = draft.apiKeyMode === "set" || draft.apiKeyMode === "clear" ? draft.apiKeyMode : "keep";
      const apiKey = textValue(draft.apiKey, 4096);
      if (apiKeyMode === "set" && draft.apiKey !== undefined && typeof draft.apiKey !== "string") throw new Error("API 密钥无效");
      const models = normalizeModels(draft.models);

      const previous = existingId ? (isObject(providers[existingId]) ? providers[existingId] : {}) : {};
      const next = existingId ? { ...previous } : {};
      if (name !== undefined) {
        if (name) next.name = name;
        else delete next.name;
      }
      if (packageName !== undefined) {
        if (packageName) {
          if (legacy) next.npm = packageName;
          else next.package = packageName;
        } else if (existingId) {
          if (legacy) delete next.npm;
          else delete next.package;
        }
      }
      const containerKey = legacy ? "options" : "settings";
      const container = isObject(next[containerKey]) ? { ...next[containerKey] } : {};
      if (baseURL !== undefined) {
        if (baseURL) container.baseURL = baseURL;
        else delete container.baseURL;
      }
      if (apiKeyMode === "set" && apiKey) container.apiKey = apiKey;
      else if (apiKeyMode === "clear") delete container.apiKey;
      if (Object.keys(container).length > 0) next[containerKey] = container;
      else delete next[containerKey];
      next.models = mergeModels(previous.models, models, legacy);

      if (existingId && existingId !== id) delete providers[existingId];
      providers[id] = next;

      const updates = { [document.key]: providers };
      if (existingId && existingId !== id) {
        const updateRef = (value) => {
          if (typeof value === "string" && value.startsWith(`${existingId}/`)) return `${id}/${value.slice(existingId.length + 1)}`;
          if (isObject(value) && value.providerID === existingId) return { ...value, providerID: id };
          return value;
        };
        if (document.data.model !== undefined) updates.model = updateRef(document.data.model);
        if (document.data.small_model !== undefined) updates.small_model = updateRef(document.data.small_model);
      }
      const result = writeUpdates(document, updates);
      return { ok: true, backup: result.backup, changed: result.changed, config: snapshot(readDocument()) };
    } catch (error) {
      return failure(error);
    }
  }

  function deleteProvider(providerId) {
    try {
      const id = textValue(providerId, 64);
      if (!id) throw new Error("服务商 ID 无效");
      const document = readDocument();
      if (!isObject(document.data)) throw new Error("配置中没有可删除的服务商");
      const providers = Object.assign(Object.create(null), isObject(document.data[document.key]) ? document.data[document.key] : {});
      if (!providers[id]) throw new Error("服务商不存在，请重新加载");
      delete providers[id];
      const updates = { [document.key]: providers };
      const clearRef = (value) => {
        if (typeof value === "string" && value.startsWith(`${id}/`)) return null;
        if (isObject(value) && value.providerID === id) return null;
        return value;
      };
      let clearedDefault = false;
      if (document.data.model !== undefined) {
        updates.model = clearRef(document.data.model);
        if (updates.model === null) clearedDefault = true;
      }
      if (document.data.small_model !== undefined) {
        updates.small_model = clearRef(document.data.small_model);
        if (updates.small_model === null) clearedDefault = true;
      }
      const result = writeUpdates(document, updates);
      return { ok: true, backup: result.backup, changed: result.changed, clearedDefault, config: snapshot(readDocument()) };
    } catch (error) {
      return failure(error);
    }
  }

  function setDefaultModel(input) {
    try {
      const request = isObject(input) ? input : { model: input };
      const document = readDocument();
      const updates = {};
      if (request.model !== undefined) {
        if (request.model === null || request.model === "") updates.model = null;
        else {
          const model = textValue(request.model, 300);
          if (!model || !/^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/.test(model)) {
            throw new Error("默认模型格式无效，应为 provider/model");
          }
          updates.model = model;
        }
      }
      if (request.smallModel !== undefined) {
        if (request.smallModel === null || request.smallModel === "") updates.small_model = null;
        else {
          const model = textValue(request.smallModel, 300);
          if (!model || !/^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/.test(model)) {
            throw new Error("小型任务模型格式无效，应为 provider/model");
          }
          updates.small_model = model;
        }
      }
      if (Object.keys(updates).length === 0) throw new Error("没有要保存的模型设置");
      if (!document.text.trim() && updates.model === null && updates.small_model === null) {
        return { ok: true, changed: false, config: snapshot(document) };
      }
      if (!document.text.trim()) {
        for (const key of Object.keys(updates)) if (updates[key] === null) delete updates[key];
        if (Object.keys(updates).length === 0) return { ok: true, changed: false, config: snapshot(document) };
      }
      const result = writeUpdates(document, updates);
      return { ok: true, backup: result.backup, changed: result.changed, config: snapshot(readDocument()) };
    } catch (error) {
      return failure(error);
    }
  }

  function resolveApiKey(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return { key: "" };
    const envMatch = /^\{env:([^}]+)\}$/.exec(raw) || /^\$\{([^}]+)\}$/.exec(raw);
    if (envMatch) {
      const name = envMatch[1].trim();
      const key = process.env[name] ?? env[name] ?? "";
      return key ? { key } : { error: `环境变量 ${name} 未设置` };
    }
    const fileMatch = /^\{file:([^}]+)\}$/.exec(raw);
    if (fileMatch) {
      let file = fileMatch[1].trim();
      if (file.startsWith("~/") || file.startsWith("~\\")) file = path.join(home, file.slice(2));
      else if (!path.isAbsolute(file)) file = path.join(path.dirname(resolveConfigPath()), file);
      try {
        const key = fs.readFileSync(file, "utf8").trim();
        return key ? { key } : { error: `密钥文件为空：${file}` };
      } catch {
        return { error: `无法读取密钥文件：${file}` };
      }
    }
    return { key: raw };
  }

  function storedApiKey(providerId) {
    if (!providerId) return undefined;
    try {
      const document = readDocument();
      if (!isObject(document.data)) return undefined;
      const entry = document.data[document.key]?.[providerId];
      if (!isObject(entry)) return undefined;
      const value = entry.settings?.apiKey ?? entry.options?.apiKey;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async function catalog() {
    try {
      if (typeof listModels !== "function") return { ok: false, models: [], error: "当前版本不支持读取 opencode 模型目录" };
      const value = await listModels();
      const source = Array.isArray(value) ? value : value?.models;
      const seen = new Set();
      const models = [];
      for (const item of Array.isArray(source) ? source : []) {
        const id = textValue(item, 300);
        if (!id || /\s/.test(id) || !/^[^/]+\/.+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        models.push(id);
        if (models.length >= 2000) break;
      }
      return { ok: true, models };
    } catch (error) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function discoverModels(request) {
    const baseURL = textValue(request?.baseURL, 4096);
    if (!baseURL) return { ok: false, error: "请先填写 Base URL", models: [], url: "" };
    let keySource = request?.apiKey;
    if (keySource === undefined && request?.useStoredKey !== false) {
      keySource = storedApiKey(textValue(request?.providerId, 64));
    }
    const resolved = resolveApiKey(keySource);
    if (resolved.error) return { ok: false, error: resolved.error, models: [], url: baseURL };
    let candidates;
    try {
      const url = new URL(baseURL);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 只支持 http 或 https");
      candidates = modelCandidates(baseURL);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Base URL 无效", models: [], url: baseURL };
    }
    if (typeof fetchImpl !== "function") {
      return { ok: false, error: "当前环境不支持网络请求", models: [], url: candidates[0] };
    }
    let lastError = "";
    for (const url of candidates) {
      let response;
      try {
        const headers = { Accept: "application/json" };
        if (resolved.key) headers.Authorization = `Bearer ${resolved.key}`;
        if (/^https:\/\/api\.anthropic\.com$/i.test(new URL(url).origin)) {
          headers["x-api-key"] = resolved.key;
          headers["anthropic-version"] = "2023-06-01";
        }
        response = await fetchImpl(url, {
          method: "GET",
          headers,
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) : undefined,
        });
      } catch (error) {
        lastError = error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "请求超时，请检查服务地址"
          : `无法连接模型服务：${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      const bodyText = await response.text().catch(() => "");
      let payload;
      try { payload = bodyText ? JSON.parse(bodyText) : {}; } catch { payload = undefined; }
      if (!response.ok) {
        lastError = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${payload ? `：${shortError(payload, "")}` : ""}`.replace(/：$/, "");
        // Wrong path is worth trying the next candidate; an auth failure is not.
        if (response.status === 401 || response.status === 403 || response.status === 400) {
          return { ok: false, error: lastError, models: [], url, status: response.status };
        }
        continue;
      }
      const models = parseModelList(payload);
      return { ok: true, models, url, status: response.status };
    }
    return { ok: false, error: lastError || "未能从该地址读取模型列表", models: [], url: candidates[0] };
  }

  return {
    load,
    snapshot: load,
    saveProvider,
    deleteProvider,
    setDefaultModel,
    catalog,
    discover: discoverModels,
    discoverModels,
    resolveConfigPath,
  };
}

module.exports = {
  DEFAULT_PACKAGE,
  createOpenCodeModelsStore,
  parseJsonc,
  parseModelList,
  removeTopLevelValue,
  setTopLevelValue,
  credentialInfo,
};
