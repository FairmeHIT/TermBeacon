/**
 * electron-builder configuration for TermBeacon.
 * Native module strategy: node-pty 1.1.0 ships N-API prebuilds under
 * node_modules/node-pty/prebuilds/<platform>-<arch>/ (conpty.node, pty.node,
 * winpty.dll and friends). N-API modules are ABI-stable across Electron
 * versions, so we disable the MSVC rebuild (the packaging machine has no
 * Visual Studio toolchain) and ship the prebuilt binaries in the asar-unpacked
 * node_modules tree.
 */
module.exports = {
  appId: "com.fairmhit.termbeacon",
  productName: "TermBeacon",
  copyright: "Copyright (c) 2026 FairmeHIT",
  directories: { output: "D:/temp-termbeacon-release", buildResources: "build" },
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
