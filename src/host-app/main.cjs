// Detached PTY host entry point. This is launched as a second Electron app
// with no windows, so its event loop survives the TermBeacon UI process.
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

// This entry is the development PTY host. Keep its Chromium profile separate
// from the installed host (`termbeacon-host`) so a dev session and the installed
// app can run at the same time without contending for one profile lock.
app.setName("termbeacon-host-dev");
app.setPath("userData", path.join(app.getPath("appData"), "termbeacon-host-dev"));

app.whenReady().then(() => {
  // Electron exits a main process with no windows on some Windows builds.
  // Keep one hidden window as a lightweight lifetime anchor; it never loads
  // UI content and is not exposed to the user.
  const lifetimeWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  void lifetimeWindow.loadURL("about:blank");
  require("../main/pty-host.cjs");
});

process.on("uncaughtException", (error) => {
  console.error("[termbeacon-host] uncaught exception", error);
  app.exit(1);
});

// The Named Pipe server owns this process lifetime.
app.on("window-all-closed", () => {});
