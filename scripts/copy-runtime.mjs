import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(process.cwd());
const target = resolve(root, "dist/main");
mkdirSync(target, { recursive: true });
for (const file of ["pty-host.cjs", "pty-validation.cjs", "preload.cjs", "detection-engine.cjs", "agent-registry.cjs", "cli-discovery.cjs", "platform.cjs"]) {
  copyFileSync(resolve(root, "src/main", file), resolve(target, file));
}
