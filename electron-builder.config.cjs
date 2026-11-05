/** electron-builder configuration for TermBeacon. */
module.exports = {
  appId: "com.fairmhit.termbeacon",
  productName: "TermBeacon",
  copyright: "Copyright (c) 2026 FairmeHIT",
  // Development-stage convention: build into the in-repo release/ directory
  // (git-ignored). NOTE: this Windows machine previously hit persistent EBUSY
  // from a local filter driver when the builder extracted the Electron dist
  // into an in-project path (HANDOFF 6.8). If that recurs, either retry or
  // point output at a project-external path for the build run.
  directories: { output: "release", buildResources: "build" },
  // Point the builder at a pre-extracted Electron distribution so it never
  // performs the extract-then-atomic-move step that trips the local filter
  // driver's EBUSY (HANDOFF 6.8). Extract once via:
  //   tar -xf %LOCALAPPDATA%\electron\Cache\<hash>\electron-v<ver>-win32-x64.zip -C <cache>\electron-dist-<ver>-win32-x64
  electronDist: process.platform === "win32"
    ? `${process.env.LOCALAPPDATA}/electron-builder/Cache/electron-dist-36.9.5-win32-x64`
    : undefined,
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
