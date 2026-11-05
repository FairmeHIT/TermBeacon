/**
 * electron-builder configuration for TermBeacon.
 * Native module strategy: node-pty 1.1.0 ships N-API prebuilds under
 * node_modules/node-pty/prebuilds/<platform>-<arch>/ (conpty.node, pty.node,
 * winpty.dll and friends). N-API modules are ABI-stable across Electron
 * versions, so we disable the MSVC rebuild (the packaging machine has no
 * Visual Studio toolchain) and ship the prebuilt binaries in the asar-unpacked
 * node_modules tree.
 */
const isWindowsHost = process.platform === "win32";

module.exports = {
  appId: "com.fairmhit.termbeacon",
  productName: "TermBeacon",
  copyright: "Copyright (c) 2026 FairmeHIT",
  // Windows host only: keep the output outside the project tree — the
  // in-project release/ directory hits persistent EBUSY from a local filter
  // driver during Electron dist extraction (see HANDOFF 6.8). macOS/Linux
  // hosts use the default in-tree release/ path.
  directories: { output: isWindowsHost ? "D:/temp-termbeacon-release" : "release", buildResources: "build" },
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
    "!release-out/**/*",
  ],
  asarUnpack: [
    "node_modules/node-pty/**/*",
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  mac: {
    // Built from a macOS machine via `npm run dist:mac`. node-pty ships
    // darwin-x64/darwin-arm64 N-API prebuilds, so no toolchain rebuild is
    // needed there either. Keep the output project-external per HANDOFF 6.8
    // only for this Windows machine; macOS can use the default in-tree path.
    target: [{ target: "dmg", arch: ["x64", "arm64"] }],
    category: "public.app-category.developer-tools",
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
