const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createCliManager, CATALOG } = require("../src/main/cli-manager.cjs");
const { runFile, invocation, managedRoot, managedBin, managedEnvironment, shellCommand } = require("../src/main/cli-runtime.cjs");
const { resolveAssets, agentIntegrationStatus } = require("../src/main/integration-config.cjs");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tb cli home "));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const npm = path.join(home, "tools with spaces", "npm.cmd");
  const npmJs = path.join(path.dirname(npm), "node_modules/npm/bin/npm-cli.js");
  await fs.mkdir(path.dirname(npmJs), { recursive: true });
  await fs.writeFile(npmJs, "");
  const systemCli = path.join(home, "system cli.cjs");
  await fs.writeFile(systemCli, 'console.log("CLI 1.0.0")');
  const events = [];
  const installs = [];
  const state = { version: "2.2.1", fail: false, mismatch: false, hold: null };
  const find = async (command) => command === "node" ? [process.execPath] : command === "npm" ? [npm] : [systemCli];
  const run = async (file, args, options) => {
    if (args[0] !== npmJs) return runFile(file, args, options);
    installs.push({ file, args, options });
    if (state.hold) await state.hold;
    if (state.fail) throw new Error("network failure");
    const directory = args[args.indexOf("--prefix") + 1];
    const spec = args.at(-1);
    const id = Object.keys(CATALOG).find((key) => spec.startsWith(CATALOG[key].package + "@"));
    const root = path.join(directory, "node_modules", CATALOG[id].package);
    await fs.mkdir(path.join(root, "bin"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: state.version, bin: { [CATALOG[id].command]: "bin/cli.cjs" } }));
    await fs.writeFile(path.join(root, "bin/cli.cjs"), `console.log(${JSON.stringify(state.mismatch ? "CLI 0.0.1" : `CLI ${state.version}`)})`);
    options.onOutput?.("installed test package");
    return "installed";
  };
  const assets = resolveAssets({ appPath: path.resolve(__dirname, "..") });
  const manager = createCliManager({ home, assets, find, run, registry: async (name) => ({ name, version: state.version }), onProgress: (event) => events.push(event), platform: "win32" });
  return { home, manager, state, installs, events, systemCli, assets };
}
const apply = async (manager, id, action) => manager.execute({ token: (await manager.plan({ id, action })).token });

test("CLI operations accept only catalog IDs, fixed actions and single-use preview tokens", async (t) => {
  const { manager, installs } = await fixture(t);
  await assert.rejects(manager.plan({ id: "../codex", action: "install" }), /不支持/);
  await assert.rejects(manager.plan({ id: "constructor", action: "install" }), /不支持/);
  await assert.rejects(manager.plan({ id: "codex", action: "exec" }), /不支持/);
  await assert.rejects(manager.execute({ token: "arbitrary" }), /失效/);
  assert.equal(installs.length, 0);
  const plan = await manager.plan({ id: "codex", action: "install" });
  await manager.execute({ token: plan.token });
  await assert.rejects(manager.execute({ token: plan.token }), /失效/);
});

test("standard install uses pinned official packages, verifies before activation and preserves system install", async (t) => {
  const { manager, installs, home, events, systemCli } = await fixture(t);
  await apply(manager, "opencode", "install");
  const manifest = JSON.parse(await fs.readFile(path.join(managedRoot(home), "manifest.json")));
  assert.equal(manifest.agents.opencode.source, "managed");
  assert.equal(installs[0].args.at(-1), "@opencode/cli@2.2.1");
  assert.equal(installs[0].args[installs[0].args.indexOf("--registry") + 1], "https://registry.npmjs.org");
  assert.equal(await fs.readFile(systemCli, "utf8"), 'console.log("CLI 1.0.0")');
  const scan = await manager.scan();
  const opencode = scan.agents.find((item) => item.id === "opencode");
  assert.equal(opencode.version, "2.2.1");
  assert.equal(opencode.integration.state, "configured");
  assert.ok(opencode.externalPaths.includes(systemCli));
  const launch = await manager.launch({ id: "opencode", shell: "powershell.exe" });
  assert.ok(launch.command.startsWith("& '"));
  assert.match(launch.command, /'--standalone'$/);
  assert.equal(events.at(-1).phase, "done");
  if (process.platform === "win32") {
    const result = require("node:child_process").spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${path.join(managedBin(home), "opencode.cmd")}" --version"`], { windowsVerbatimArguments: true, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\.2\.1/);
  }
});

test("download failure and version mismatch keep the previous manifest and launcher intact", async (t) => {
  const { manager, state, home } = await fixture(t);
  await apply(manager, "codex", "install");
  const file = path.join(managedRoot(home), "manifest.json");
  const launcher = path.join(managedBin(home), "codex.cmd");
  const oldManifest = await fs.readFile(file, "utf8");
  const oldLauncher = await fs.readFile(launcher, "utf8");
  state.version = "2.2.2";
  state.fail = true;
  await assert.rejects(apply(manager, "codex", "update"), /network failure/);
  state.fail = false;
  state.mismatch = true;
  await assert.rejects(apply(manager, "codex", "reinstall"), /版本验证失败/);
  assert.equal(await fs.readFile(file, "utf8"), oldManifest);
  assert.equal(await fs.readFile(launcher, "utf8"), oldLauncher);
  assert.equal((await manager.scan()).agents.find((item) => item.id === "codex").operation.phase, "error");
});

test("switching between system and managed keeps the managed release for reuse", async (t) => {
  const { manager, home } = await fixture(t);
  await apply(manager, "codex", "install");
  await apply(manager, "codex", "use-system");
  const system = (await manager.scan()).agents.find((item) => item.id === "codex");
  assert.equal(system.source, "system");
  assert.equal(system.managedInstalled, true);
  await assert.rejects(fs.access(path.join(managedBin(home), "codex.cmd")));
  await apply(manager, "codex", "use-managed");
  assert.equal((await manager.scan()).agents.find((item) => item.id === "codex").source, "managed");
});

test("same-agent operations lock before the first await and parallel agents merge manifest writes", async (t) => {
  const { manager, state, home, installs } = await fixture(t);
  const first = await manager.plan({ id: "codex", action: "install" });
  const duplicate = await manager.plan({ id: "codex", action: "reinstall" });
  let release;
  state.hold = new Promise((resolve) => { release = resolve; });
  const running = manager.execute({ token: first.token });
  await assert.rejects(manager.execute({ token: duplicate.token }), /正在执行/);
  release();
  await running;
  state.hold = null;
  await assert.rejects(manager.execute({ token: duplicate.token }), /状态已变化/);
  await Promise.all([apply(manager, "pi", "install"), apply(manager, "claude", "install")]);
  const stored = JSON.parse(await fs.readFile(path.join(managedRoot(home), "manifest.json")));
  assert.deepEqual(Object.keys(stored.agents).sort(), ["claude", "codex", "pi"]);
  assert.ok(installs.find((item) => item.args.at(-1).startsWith("@earendil-works/")).args.includes("--ignore-scripts"));
});

test("integration reports content drift and preserves the previous extension", async (t) => {
  const { manager, home, assets } = await fixture(t);
  await apply(manager, "pi", "integrate");
  let status = agentIntegrationStatus({ id: "pi", home, assets });
  assert.equal(status.state, "configured");
  await fs.appendFile(status.path, "\n// user change");
  assert.equal(agentIntegrationStatus({ id: "pi", home, assets }).state, "outdated");
  await apply(manager, "pi", "integrate");
  const backups = (await fs.readdir(path.dirname(status.path))).filter((name) => name.startsWith("index.js.bak-"));
  assert.equal(backups.length, 1);
  assert.match(await fs.readFile(path.join(path.dirname(status.path), backups[0]), "utf8"), /user change/);
});

test("managed environment has a single Windows PATH key and command quoting preserves spaces", () => {
  const env = managedEnvironment({ Path: "C:\\Windows", OTHER: "yes" }, "C:\\Users\\Name With Spaces");
  assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === "path").length, 1);
  assert.equal(env.OTHER, "yes");
  assert.ok(env.Path.startsWith(managedBin("C:\\Users\\Name With Spaces")));
  assert.equal(shellCommand("C:\\A B\\cli.exe", [], "pwsh.exe"), "& 'C:\\A B\\cli.exe'");
  assert.throws(() => shellCommand("C:\\%TEMP%\\cli.exe", [], "cmd.exe"), /PowerShell/);
});

test("npm shims resolve to a direct process invocation instead of evaluating batch code", async (t) => {
  const { home } = await fixture(t);
  const shim = path.join(home, "test.cmd");
  await fs.writeFile(shim, '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
  const command = await invocation(shim, process.execPath);
  assert.equal(command.file, process.execPath);
  assert.ok(command.args[0].endsWith(path.join("@openai", "codex", "bin", "codex.js")));
  await fs.writeFile(shim, '@echo unknown & arbitrary');
  await assert.rejects(invocation(shim, process.execPath), /无法安全/);
});

test("updates can roll back to a retained verified release", async (t) => {
  const { manager, state } = await fixture(t);
  await apply(manager, "codex", "install");
  state.version = "2.2.2";
  await apply(manager, "codex", "update");
  let agent = (await manager.scan()).agents.find((item) => item.id === "codex");
  assert.equal(agent.version, "2.2.2");
  assert.equal(agent.previousVersion, "2.2.1");
  await apply(manager, "codex", "rollback");
  agent = (await manager.scan()).agents.find((item) => item.id === "codex");
  assert.equal(agent.version, "2.2.1");
  assert.equal(agent.previousVersion, "2.2.2");
});

test("a manifest commit failure restores the previous launcher", async (t) => {
  const { manager, state, home } = await fixture(t);
  await apply(manager, "codex", "install");
  const manifest = path.join(managedRoot(home), "manifest.json");
  const launcher = path.join(managedBin(home), "codex.cmd");
  const previous = await fs.readFile(launcher, "utf8");
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === manifest) throw new Error("simulated commit failure");
    return originalRename(from, to);
  });
  state.version = "2.2.2";
  await assert.rejects(apply(manager, "codex", "update"), /commit failure/);
  assert.equal(await fs.readFile(launcher, "utf8"), previous);
  assert.equal(JSON.parse(await fs.readFile(manifest)).agents.codex.version, "2.2.1");
});

test("reselecting a damaged managed release preserves the system source", async (t) => {
  const { manager, home } = await fixture(t);
  await apply(manager, "codex", "install");
  await apply(manager, "codex", "use-system");
  const file = path.join(managedRoot(home), "manifest.json");
  const before = await fs.readFile(file, "utf8");
  const entry = path.join(managedRoot(home), "codex", "releases", JSON.parse(before).agents.codex.release, "node_modules", CATALOG.codex.package, "bin", "cli.cjs");
  await fs.writeFile(entry, 'console.log("CLI 0.0.1")');
  await assert.rejects(apply(manager, "codex", "use-managed"), /托管版本验证失败/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  await assert.rejects(fs.access(path.join(managedBin(home), "codex.cmd")));
});

test("invalid release paths are reported as damaged without leaving the managed root", async (t) => {
  const { manager, home } = await fixture(t);
  const file = path.join(managedRoot(home), "manifest.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, agents: { codex: { source: "managed", release: ".." } } }));
  const codex = (await manager.scan()).agents.find((agent) => agent.id === "codex");
  assert.equal(codex.installed, false);
  assert.match(codex.error, /托管安装已损坏/);
  await assert.rejects(manager.launch({ id: "codex" }), /托管安装已损坏/);
  await fs.writeFile(file, JSON.stringify({ version: 1, agents: [] }));
  await assert.rejects(manager.scan(), /清单格式无效/);
});

test("CLI output decoding preserves UTF-8 characters split across pipe chunks", async () => {
  const script = 'const b=Buffer.from("中文");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)';
  assert.equal(await runFile(process.execPath, ["-e", script]), "中文");
});
