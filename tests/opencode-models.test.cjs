const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { after } = require("node:test");

const { createOpenCodeModelsStore } = require("../src/main/opencode-models.cjs");
const { parseModelCatalog } = require("../src/main/cli-manager.cjs");

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(configText) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "termbeacon-models-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "opencode.jsonc");
  if (configText !== undefined) fs.writeFileSync(file, configText, "utf8");
  const store = createOpenCodeModelsStore({
    home: directory,
    env: { ...process.env, OPENCODE_CONFIG_DIR: directory },
    listModels: async () => ["alpha/one", "alpha/one", "catalog/two", "not-a-model", "has space/model"],
  });
  return { directory, file, store };
}

test("snapshot reads JSONC providers and credentials without exposing the key", () => {
  const { file, store } = fixture(`{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "theme": "termbeacon-dark",
  "providers": {
    "alpha": {
      "name": "Alpha",
      "settings": { "baseURL": "http://127.0.0.1:11434/v1", "apiKey": "{env:ALPHA_KEY}" },
      "models": {
        "one": { "name": "One" },
        "two": { "disabled": true },
      },
    },
  },
  "model": "alpha/one",
}`);
  const snapshot = store.snapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.path, file);
  assert.equal(snapshot.directory, path.dirname(file));
  assert.equal(snapshot.format, "jsonc");
  assert.equal(snapshot.key, "providers");
  assert.equal(snapshot.model, "alpha/one");
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].name, "Alpha");
  assert.equal(snapshot.providers[0].credential.kind, "env");
  assert.equal(snapshot.providers[0].credential.hint, "{env:ALPHA_KEY}");
  assert.equal(snapshot.providers[0].models.length, 2);
  assert.equal(snapshot.providers[0].models[1].disabled, true);
});

test("literal API keys are never returned to the renderer", () => {
  const containingKey = fixture(`{
    "providers": {
      "alpha": {
        "settings": { "baseURL": "https://example.com/v1", "apiKey": "sk-literal-secret" },
        "models": { "one": {} }
      }
    }
  }`);
  const snapshot = containingKey.store.snapshot();
  assert.equal(snapshot.providers[0].credential.kind, "literal");
  assert.equal(JSON.stringify(snapshot).includes("sk-literal-secret"), false);
});

test("setting and clearing the default model preserves comments and unrelated settings", () => {
  const { file, store } = fixture(`{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "theme": "termbeacon-dark",
  "providers": { "alpha": { "models": { "one": {}, "two": {} } } },
  "model": "alpha/one",
}`);
  const saved = store.setDefaultModel("alpha/two");
  assert.equal(saved.ok, true);
  assert.equal(saved.changed, true);
  assert.equal(saved.config.model, "alpha/two");
  let text = fs.readFileSync(file, "utf8");
  assert.match(text, /keep this comment/);
  assert.match(text, /"theme": "termbeacon-dark"/);
  assert.match(text, /"model": "alpha\/two"/);

  const cleared = store.setDefaultModel(null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.config.model, undefined);
  text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /"model"\s*:/);
  assert.match(text, /keep this comment/);
});

test("saving and deleting a provider keeps unknown fields and clears its model reference", () => {
  const { directory, file, store } = fixture(`{
  // keep this comment
  "providers": {
    "alpha": {
      "name": "Alpha",
      "settings": { "baseURL": "http://127.0.0.1:11434/v1", "apiKey": "{env:ALPHA_KEY}" },
      "models": { "one": { "name": "One" }, "two": {} },
      "custom": "keep-me",
    },
  },
  "model": "alpha/one",
  "small_model": "alpha/two",
}`);
  const saved = store.saveProvider({
    id: "alpha",
    originalId: "alpha",
    name: "Alpha Renamed",
    baseURL: "http://127.0.0.1:11434/v1",
    package: "@opencode/ai/providers/openai-compatible",
    apiKeyMode: "keep",
    models: [{ id: "one", name: "One" }, { id: "three" }],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.changed, true);
  let snapshot = store.snapshot();
  assert.equal(snapshot.providers[0].name, "Alpha Renamed");
  assert.deepEqual(snapshot.providers[0].models.map((model) => model.id), ["one", "three"]);
  assert.equal(snapshot.providers[0].credential.kind, "env");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /keep this comment/);
  assert.match(text, /"custom": "keep-me"/);
  assert.ok(fs.readdirSync(directory).some((name) => name.startsWith("opencode.jsonc.bak-termbeacon-")));

  const removed = store.deleteProvider("alpha");
  assert.equal(removed.ok, true);
  assert.equal(removed.clearedDefault, true);
  snapshot = store.snapshot();
  assert.deepEqual(snapshot.providers, []);
  assert.equal(snapshot.model, undefined);
  assert.equal(snapshot.smallModel, undefined);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /keep this comment/);
  assert.doesNotMatch(after, /"alpha"/);
});

test("the catalog method validates and deduplicates injected model ids", async () => {
  const { store } = fixture(undefined);
  const result = await store.catalog();
  assert.deepEqual(result, { ok: true, models: ["alpha/one", "catalog/two"] });

  const failing = createOpenCodeModelsStore({
    home: os.tmpdir(),
    env: { ...process.env, OPENCODE_CONFIG_DIR: os.tmpdir() },
    listModels: async () => { throw new Error("opencode unavailable"); },
  });
  assert.deepEqual(await failing.catalog(), { ok: false, models: [], error: "opencode unavailable" });
});

test("opencode model output parsing ignores ansi noise, logs and duplicates", () => {
  assert.deepEqual(parseModelCatalog([
    "\u001b[32mopencode-go/beam-free\u001b[0m",
    "openrouter/~anthropic/claude-fable-latest",
    "opencode-go/beam-free",
    "warning: something happened",
    "",
  ].join("\r\n")), [
    "opencode-go/beam-free",
    "openrouter/~anthropic/claude-fable-latest",
  ]);
});
