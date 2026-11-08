const { randomUUID } = require("node:crypto");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");

// GitHub can return an edge timeout for a versioned asset URL even while a
// fresh request for the same asset succeeds. Preserve the official download
// path and checksum metadata, and give each request its own cache key.
function freshReleaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "github.com" && url.pathname.includes("/releases/download/")) {
    url.searchParams.set("noCache", randomUUID());
  }
  return url;
}

class FreshGitHubProvider extends GitHubProvider {
  createRequestOptions(url, headers) {
    return super.createRequestOptions(freshReleaseUrl(url), headers);
  }

  resolveFiles(updateInfo) {
    return super.resolveFiles(updateInfo).map((file) => ({ ...file, url: freshReleaseUrl(file.url) }));
  }
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NETWORK_ERROR = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED)\b|\b(?:network|request|connection|gateway) (?:error|timeout|timed out)\b/i;

function errorDetails(error) {
  const messages = [];
  const visited = new Set();
  let status;
  for (let current = error; current != null && !visited.has(current); current = current.cause) {
    visited.add(current);
    const message = typeof current === "string" ? current : String(current.message || current.code || "");
    messages.push(message, String(current.code || ""));
    const numericStatus = Number(current.statusCode || current.status);
    const match = message.match(/(?:^|\bHttpError:\s*|\bHTTP(?: error)?[:\s]+|\bstatus(?:Code)?[:=\s]+)([45]\d{2})\b/im);
    if (status === undefined && numericStatus >= 400 && numericStatus <= 599) status = numericStatus;
    if (status === undefined && match) status = Number(match[1]);
  }
  return { status, message: messages.join("\n") };
}

function isTransientUpdateError(error) {
  const { status, message } = errorDetails(error);
  return status === undefined ? NETWORK_ERROR.test(message) : RETRY_STATUSES.has(status);
}

function formatUpdateError(error) {
  const { status, message } = errorDetails(error);
  if (status === 408 || status === 504) return `GitHub 更新服务器响应超时（HTTP ${status}），请稍后重试。`;
  if (status === 429) return "GitHub 更新请求过于频繁，请稍后重试。";
  if (status !== undefined && status >= 500) return `GitHub 更新服务器暂时不可用（HTTP ${status}），请稍后重试。`;
  if (status === 404) return "未找到更新文件（HTTP 404），请稍后重试或从发布页下载安装包。";
  if (status !== undefined) return `无法获取更新文件（HTTP ${status}），请稍后重试。`;
  if (NETWORK_ERROR.test(message)) return "连接 GitHub 更新服务器失败，请检查网络后重试。";
  if (/sha(?:256|512)|checksum|signature|ERR_UPDATER_(?:INVALID|CHANNEL_FILE)/i.test(message)) {
    return "更新文件校验失败，请稍后重试或从发布页下载安装包。";
  }
  return "无法检查更新，请稍后重试或从发布页下载安装包。";
}

async function checkForUpdatesWithRetry(check, options = {}) {
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const delays = [1000, 3000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await check();
    } catch (error) {
      if (attempt >= delays.length || !isTransientUpdateError(error)) throw error;
      options.onRetry?.(attempt + 2, delays.length + 1);
      await wait(delays[attempt]);
    }
  }
}

module.exports = { FreshGitHubProvider, checkForUpdatesWithRetry, formatUpdateError, isTransientUpdateError };
