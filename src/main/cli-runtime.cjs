const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function managedRoot(home = os.homedir()) { return path.join(home, ".termbeacon", "agents"); }
function managedBin(home = os.homedir()) { return path.join(managedRoot(home), "bin"); }
function managedEnvironment(env = process.env, home = os.homedir()) {
  // Windows environment keys are case insensitive; do not publish both Path and PATH.
  const next = { ...env };
  const keys = Object.keys(next).filter((item) => item.toLowerCase() === "path");
  const key = keys.at(-1) || "PATH";
  const entries = String(next[key] || "").split(path.delimiter).filter(Boolean);
  for (const duplicate of keys) if (duplicate !== key) delete next[duplicate];
  next[key] = [managedBin(home), ...entries.filter((item) => path.resolve(item).toLowerCase() !== managedBin(home).toLowerCase())].join(path.delimiter);
  return next;
}

function runFile(file, args = [], { timeout = 10000, env = process.env, cwd, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const collect = (data) => {
      const chunk = data;
      output = (output + chunk).slice(-32768);
      onOutput?.(chunk.slice(-4096));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(Object.assign(new Error(timedOut ? "命令执行超时" : output.trim().slice(-2000) || `命令退出 (${code})`), { code, output }));
      else resolve(output.trim());
    });
  });
}

async function findCommands(command, { env = process.env, exclude = [], platform = process.platform, home = os.homedir() } = {}) {
  const key = Object.keys(env).find((item) => item.toLowerCase() === "path");
  const directories = String(env[key] || "").split(path.delimiter).filter(Boolean);
  directories.push(path.join(home, ".local", "bin"), path.join(home, ".opencode", "bin"), path.join(home, ".bun", "bin"));
  if (platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"), path.join(home, "Library", "pnpm"));
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  const normalize = (value) => platform === "win32" ? value.toLowerCase() : value;
  const seen = new Set();
  const candidates = [];
  for (const dir of directories) {
    for (const suffix of suffixes) {
      const target = path.resolve(dir, command + suffix);
      const normalized = normalize(target);
      if (seen.has(normalized) || exclude.some((root) => normalized.startsWith(normalize(path.resolve(root)) + path.sep))) continue;
      seen.add(normalized);
      candidates.push(target);
    }
  }
  const checks = await Promise.all(candidates.map(async (target) => {
    try { await fs.promises.access(target, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return target; } catch { return null; }
  }));
  return checks.filter(Boolean);
}

async function invocation(executable, nodePath) {
  if (/\.[cm]?js$/i.test(executable)) {
    if (!nodePath) throw new Error("此 CLI 需要系统 Node.js，请先安装 Node.js");
    return { file: nodePath, args: [executable] };
  }
  if (!/\.(cmd|bat)$/i.test(executable)) return { file: executable, args: [] };
  // Resolve npm shims without cmd.exe: paths with spaces work and shell syntax
  // from a path is never evaluated. Unknown batch launchers remain detectable.
  const shim = await fs.promises.readFile(executable, "utf8");
  const relative = [...shim.matchAll(/"%(?:dp0|~dp0)%?\\([^"\r\n]+\.(?:exe|[cm]?js))"/gi)]
    .map((match) => match[1]).find((item) => /node_modules[\\/]/.test(item));
  if (!relative) throw new Error("此启动脚本无法安全读取版本；可改用标准化安装");
  const entry = path.resolve(path.dirname(executable), relative);
  return invocation(entry, nodePath);
}

function shellCommand(executable, args = [], shell = "cmd.exe") {
  const values = [executable, ...args];
  if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return "& " + values.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(" ");
  if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) {
    if (values.some((s) => /[%!"\r\n]/.test(s))) throw new Error("此路径包含 cmd 无法安全引用的字符，请选择 PowerShell");
    return values.map((s) => `"${s}"`).join(" ");
  }
  return values.map((s) => `'${String(s).replace(/'/g, "'\\''")}'`).join(" ");
}

module.exports = { managedRoot, managedBin, managedEnvironment, runFile, findCommands, invocation, shellCommand };
