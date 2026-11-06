// Detached PTY host entry point. This is launched as a second Electron app
// with no windows, so its event loop survives the TermBeacon UI process.
const { app, BrowserWindow } = require("electron");

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
