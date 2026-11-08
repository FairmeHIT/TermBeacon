import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(process.cwd());
const target = resolve(root, "dist/main");
mkdirSync(target, { recursive: true });
for (const file of ["pty-host.cjs", "pty-validation.cjs", "preload.cjs", "detection-engine.cjs", "osc-parser.cjs", "agent-sniff.cjs", "hook-server.cjs", "host-restart.cjs", "summary-utils.cjs", "agent-registry.cjs", "cli-discovery.cjs", "platform.cjs", "state-sanitize.cjs", "session-resume.cjs", "window-bounds.cjs", "integration-config.cjs", "update-check.cjs", "terminal-history.cjs", "utf8-utils.cjs", "output-flow.cjs"]) {
  copyFileSync(resolve(root, "src/main", file), resolve(target, file));
}
const hostApp = resolve(root, "dist/host-app");
for (const file of ["cli-manager.cjs", "cli-runtime.cjs"]) {
  copyFileSync(resolve(root, "src/main", file), resolve(target, file));
}
copyFileSync(resolve(root, "scripts/termbeacon-hook.cjs"), resolve(target, "hook-client.cjs"));
mkdirSync(hostApp, { recursive: true });
copyFileSync(resolve(root, "src/host-app/main.cjs"), resolve(hostApp, "main.cjs"));
copyFileSync(resolve(root, "src/host-app/package.json"), resolve(hostApp, "package.json"));
