const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { registerLedgerFile } = require("./ledgerFile.cjs");
const { registerSync } = require("./phone-sync/syncMain.cjs");

const DIST_DIR = path.join(__dirname, "..", "dist");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: path.join(DIST_DIR, "favicon.ico"),
    webPreferences: {
      // Gives the page window.fleetDesktop: the SQLite database in %APPDATA%\FleetPilot (see ledgerFile.cjs).
      preload: path.join(__dirname, "ledgerPreload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Links that open a new window (target="_blank", window.open) go to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // The app is a single page loaded from disk; never navigate the window anywhere else.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(DIST_DIR, "index.html"));
}

// A second launch focuses the existing window instead of opening another copy
// that would compete for the same local database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Database handlers and the "save before closing" hook must exist before the window opens.
    const store = registerLedgerFile();
    registerSync(store);                               // phone sync: the screen starts the connection once the database is open, and it stays on until the app closes
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
