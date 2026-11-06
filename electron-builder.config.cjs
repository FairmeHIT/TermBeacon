/** electron-builder configuration for TermBeacon. */
const fs = require("node:fs");
const path = require("node:path");

// A developer may point the builder at an already extracted Electron runtime
// to work around a local file-lock issue. The path is optional: a clean clone
// must be able to use electron-builder's normal download/cache flow.
function resolveElectronDist() {
  const configured = process.env.TERMBEACON_ELECTRON_DIST;
  if (!configured) return undefined;
  const candidate = path.resolve(configured);
  return fs.existsSync(path.join(candidate, "electron.exe")) ? candidate : undefined;
}

module.exports = {
  appId: "com.fairmhit.termbeacon",
  productName: "TermBeacon",
  copyright: "Copyright (c) 2026 FairmeHIT",
  // Development-stage convention: build into the in-repo release/ directory
  // (git-ignored). NOTE: this Windows machine previously hit persistent EBUSY
  // from a local filter driver when the builder extracted the Electron dist
  // into an in-project path. If that recurs, either retry or point output at
  // a project-external path for the build run.
  directories: { output: "release", buildResources: "build" },
  publish: [{ provider: "github", owner: "FairmeHIT", repo: "TermBeacon", releaseType: "release" }],
  // Set TERMBEACON_ELECTRON_DIST to an extracted Electron directory only when
  // the local machine needs the file-lock workaround. Normal clones do not
  // depend on a machine-specific cache path.
  electronDist: resolveElectronDist(),
  npmRebuild: false,
  buildDependenciesFromSource: false,
  files: [
    "dist/**/*",
    "package.json",
    "!**/*.map",
    "!**/*.ts",
    "!**/*.tsx",
    "!tests/**/*",
    "!docs/**/*",
    "!scripts/**/*",
    "!src/**/*",
    "!release/**/*",
  ],
  asarUnpack: [
    "node_modules/node-pty/**/*",
  ],
  extraResources: [
    { from: "hooks/opencode/termbeacon.js", to: "termbeacon-hooks/opencode/termbeacon.js" },
    { from: "scripts/termbeacon-hook.cjs", to: "termbeacon-hooks/termbeacon-hook.cjs" },
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    signAndEditExecutable: true,
    forceCodeSigning: process.env.TERMBEACON_FORCE_SIGNING === "1",
  },
  mac: {
    // Built from a macOS machine via `npm run dist:mac`. node-pty ships
    // darwin-x64/darwin-arm64 N-API prebuilds, so no toolchain rebuild is
    // needed there either. Keep the output project-external on hosts that
    // encounter local file-lock issues; macOS can use the default path.
    target: [{ target: "dmg", arch: ["x64", "arm64"] }],
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    gatekeeperAssess: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "TermBeacon",
    artifactName: "${productName}-${version}-setup.${ext}",
  },
};
