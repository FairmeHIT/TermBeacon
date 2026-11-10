const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { FreshGitHubProvider, checkForUpdatesWithRetry, formatUpdateError, isTransientUpdateError } = require("../src/main/update-check.cjs");

const manifest = "version: 0.1.12\nfiles:\n  - url: TermBeacon-0.1.12-setup.exe\n    sha512: published-checksum\n    size: 95819592\n";
const timeout = () => Object.assign(new Error('504 "method: GET url: https://github.com/FairmeHIT/TermBeacon/releases/download/v0.1.12/latest.yml\nData: <html>Gateway Time-out</html>\nHeaders: {"x-github-request-id":"example"}'), { statusCode: 504 });

function providerFixture(ProviderClass) {
  const requests = [];
  const executor = { request: async (options) => {
    const url = new URL(options.path, `https://${options.hostname}`);
    requests.push(url);
    if (url.pathname.endsWith(".atom")) return '<feed><entry><title>0.1.12</title><link href="https://github.com/FairmeHIT/TermBeacon/releases/tag/v0.1.12"/><content>Release notes</content></entry></feed>';
    if (url.pathname.endsWith("/latest")) return JSON.stringify({ tag_name: "v0.1.12" });
    if (!url.searchParams.has("noCache")) throw timeout();
    return manifest;
  } };
  return {
    provider: new ProviderClass({ owner: "FairmeHIT", repo: "TermBeacon" }, { allowPrerelease: false, channel: null }, { executor, platform: "win32" }),
    requests,
  };
}

test("fresh requests recover a GitHub manifest whose original URL returns 504", async () => {
  await assert.rejects(providerFixture(GitHubProvider).provider.getLatestVersion(), { statusCode: 504 });
  const { provider, requests } = providerFixture(FreshGitHubProvider);
  const info = await provider.getLatestVersion();
  assert.equal(info.version, "0.1.12");
  assert.equal(info.tag, "v0.1.12");
  assert.equal(info.files[0].sha512, "published-checksum");
  const firstManifest = requests.at(-1);
  await provider.getLatestVersion();
  assert.notEqual(firstManifest.search, requests.at(-1).search);
  assert.equal(firstManifest.origin, "https://github.com");
  assert.equal(firstManifest.pathname, "/FairmeHIT/TermBeacon/releases/download/v0.1.12/latest.yml");
});

test("installer and differential updates keep official paths and checksum metadata", async () => {
  const { provider } = providerFixture(FreshGitHubProvider);
  const info = await provider.getLatestVersion();
  const file = provider.resolveFiles(info)[0];
  assert.equal(file.url.origin, "https://github.com");
  assert.equal(file.url.pathname, "/FairmeHIT/TermBeacon/releases/download/v0.1.12/TermBeacon-0.1.12-setup.exe");
  assert.ok(file.url.searchParams.get("noCache"));
  assert.equal(file.info.sha512, "published-checksum");
  const [oldMap, newMap] = provider.getBlockMapFiles(file.url, "0.1.11", "0.1.12");
  assert.equal(oldMap.pathname, "/FairmeHIT/TermBeacon/releases/download/v0.1.11/TermBeacon-0.1.11-setup.exe.blockmap");
  assert.equal(newMap.pathname, `${file.url.pathname}.blockmap`);
  assert.equal(newMap.search, file.url.search);
  assert.equal(provider.isUseMultipleRangeRequest, false);
});

test("transient checks retry with backoff and return the successful result", async () => {
  let attempts = 0;
  const delays = [];
  const retries = [];
  const result = await checkForUpdatesWithRetry(async () => {
    if (++attempts < 3) throw timeout();
    return { version: "0.1.12" };
  }, { wait: async (ms) => delays.push(ms), onRetry: (...args) => retries.push(args) });
  assert.deepEqual(result, { version: "0.1.12" });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 3000]);
  assert.deepEqual(retries, [[2, 3], [3, 3]]);
});

test("persistent timeouts stop after three attempts and preserve the error", async () => {
  const error = timeout();
  let attempts = 0;
  await assert.rejects(checkForUpdatesWithRetry(async () => { attempts += 1; throw error; }, { wait: async () => {} }), (actual) => actual === error);
  assert.equal(attempts, 3);
});

test("Electron closed connections retry and recover without exposing raw errors", async () => {
  const error = new Error("net::ERR_CONNECTION_CLOSED");
  let attempts = 0;
  const result = await checkForUpdatesWithRetry(async () => {
    if (++attempts < 3) throw error;
    return { version: "0.1.14" };
  }, { wait: async () => {} });
  assert.equal(attempts, 3);
  assert.deepEqual(result, { version: "0.1.14" });
  assert.equal(formatUpdateError(error), "连接 GitHub 更新服务器失败，请检查网络后重试。");
});

test("persistent Electron closed connections stop after the bounded retry budget", async () => {
  const error = new Error("net::ERR_CONNECTION_CLOSED");
  let attempts = 0;
  await assert.rejects(checkForUpdatesWithRetry(async () => {
    attempts += 1;
    throw error;
  }, { wait: async () => {} }), (actual) => actual === error);
  assert.equal(attempts, 3);
});

test("missing files and invalid signatures fail immediately", async () => {
  for (const error of [Object.assign(new Error("Not found"), { statusCode: 404 }), new Error("net::ERR_CERT_AUTHORITY_INVALID"), new Error("sha512 checksum mismatch")]) {
    let attempts = 0;
    await assert.rejects(checkForUpdatesWithRetry(async () => { attempts += 1; throw error; }, { wait: async () => assert.fail("must not retry") }));
    assert.equal(attempts, 1);
  }
});

test("network error codes and wrapped HTTP errors are retryable", () => {
  assert.equal(isTransientUpdateError(Object.assign(new Error("connect failed"), { code: "ETIMEDOUT" })), true);
  assert.equal(isTransientUpdateError(new Error("Unable to find latest release: HttpError: 503 Service unavailable")), true);
  assert.equal(isTransientUpdateError(new Error("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })), true);
  assert.equal(isTransientUpdateError(Object.assign(new Error("Gateway timeout text in a missing file response"), { statusCode: 404 })), false);
});

test("settings messages omit server HTML, headers, and raw request details", () => {
  const message = formatUpdateError(timeout());
  assert.match(message, /HTTP 504/);
  assert.match(message, /稍后重试/);
  assert.doesNotMatch(message, /html|Headers|https:|method:|x-github/i);
  assert.equal(formatUpdateError(new Error("unexpected <html>debug</html>")), "无法检查更新，请稍后重试或从发布页下载安装包。");
});

function mainFixture(check) {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const functions = ["configureAutoUpdater", "checkForUpdatesNow"].map((name) => source.match(new RegExp(`(?:async )?function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]).join("\n");
  const { transpileModule, ScriptTarget } = require("typescript");
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => check(updater);
  const events = [];
  const context = vm.createContext({
    app: { isPackaged: true }, process: { env: {} }, console: { error() {} }, autoUpdater: updater,
    FreshGitHubProvider, formatUpdateError,
    checkForUpdatesWithRetry: (operation, options) => checkForUpdatesWithRetry(operation, { ...options, wait: async () => {} }),
    updateConfigured: false, updateCheckInFlight: false, updateStatus: { type: "idle" },
    sendUpdateEvent(type, payload = {}) {
      context.updateStatus = { type, ...payload };
      events.push(context.updateStatus);
    },
  });
  vm.runInContext(transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
  return { context, events, updater };
}

test("updater error events stay in checking state during retries", async () => {
  let attempts = 0;
  const { context, events } = mainFixture(async (updater) => {
    updater.emit("checking-for-update");
    if (++attempts < 3) {
      const error = timeout();
      updater.emit("error", error);
      throw error;
    }
    updater.emit("update-not-available", { version: "0.1.12" });
    return null;
  });
  const status = await context.checkForUpdatesNow();
  assert.equal(status.type, "not-available");
  assert.equal(events.filter(({ type }) => type === "error").length, 0);
  assert.ok(events.some(({ message }) => message?.includes("2/3")));
  assert.equal(context.updateCheckInFlight, false);
});

test("exhausted updater checks show one readable error and can be tried again", async () => {
  let attempts = 0;
  const { context, events } = mainFixture(async (updater) => {
    attempts += 1;
    const error = timeout();
    updater.emit("error", error);
    throw error;
  });
  const status = await context.checkForUpdatesNow();
  assert.equal(status.type, "error");
  assert.match(status.message, /HTTP 504/);
  assert.equal(events.filter(({ type }) => type === "error").length, 1);
  assert.equal(context.updateCheckInFlight, false);
  await context.checkForUpdatesNow();
  assert.equal(attempts, 6);
});

test("checks do not overlap and download failures are observed separately", async () => {
  let resolveCheck;
  let rejectDownload;
  let attempts = 0;
  const downloadPromise = new Promise((_, reject) => { rejectDownload = reject; });
  const { context, updater } = mainFixture(() => {
    attempts += 1;
    return new Promise((resolve) => { resolveCheck = resolve; });
  });
  const pending = context.checkForUpdatesNow();
  await context.checkForUpdatesNow();
  assert.equal(attempts, 1);
  updater.emit("download-progress", { percent: 25 });
  resolveCheck({ downloadPromise });
  await pending;
  await context.checkForUpdatesNow();
  assert.equal(attempts, 1);
  const error = timeout();
  updater.emit("error", error);
  rejectDownload(error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.updateStatus.type, "error");
  assert.match(context.updateStatus.message, /HTTP 504/);
});
