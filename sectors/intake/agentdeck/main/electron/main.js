// agentdeck desktop app: runs the agentdeck server inside the app and shows it in a native window.
import { app, BrowserWindow, shell, nativeTheme } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let win = null;
let origin = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    process.env.AGENTDECK_DESKTOP = "1";
    const { fixPath } = await import("../dist/cli.js");
    fixPath(); // apps opened from the Dock / Start menu don't get your shell's PATH
    const { start } = await import("../dist/server.js");
    const port = await start(Number(process.env.PORT ?? 4477));
    origin = `http://localhost:${port}`;
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    try {
      const { stopAllLocal } = await import("../dist/local.js");
      stopAllLocal();
    } catch {
      /* nothing running */
    }
  });
}

function createWindow() {
  const mac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 380,
    minHeight: 500,
    title: "agentdeck",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#262624" : "#faf9f5",
    icon: join(here, "..", "build", "icon.png"),
    titleBarStyle: mac ? "hiddenInset" : "default",
    trafficLightPosition: mac ? { x: 16, y: 14 } : undefined,
    autoHideMenuBar: !mac,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => (win = null));

  // Links to claude.ai, the Console, etc. open in your browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(`${origin}/?desktop=${process.platform}`);
}
