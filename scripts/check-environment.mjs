import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJsonPath = join(root, "package.json");
const lockPath = join(root, "package-lock.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const errors = [];
const warnings = [];

const [nodeMajor] = process.versions.node.split(".").map(Number);
const npmVersion = process.env.npm_config_user_agent?.match(/npm\/(\d+)/)?.[1];
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) errors.push(`Node.js 20 or newer is required (found ${process.version})`);
if (npmVersion && Number(npmVersion) < 10) errors.push(`npm 10 or newer is required (found npm ${npmVersion})`);
if (packageJson.version !== lock.version || packageJson.version !== lock.packages?.[""]?.version) {
  errors.push(`package.json and package-lock.json versions must match (package ${packageJson.version}, lock ${lock.version}/${lock.packages?.[""]?.version})`);
}

for (const dependency of ["electron", "node-pty", "vite", "typescript"]) {
  if (!existsSync(join(root, "node_modules", dependency))) errors.push(`missing dependency: ${dependency}; run npm ci`);
}
if (process.platform !== "win32") warnings.push("The packaged PTY path targets Windows; run npm run dist on Windows for the installer.");

for (const warning of warnings) console.warn(`[doctor] warning: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`[doctor] error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[doctor] ready: ${packageJson.name} ${packageJson.version} on Node ${process.version}`);
}
