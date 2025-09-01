/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import { app, BrowserWindow, shell, Menu } from "electron";
import { serve } from "@hono/node-server";
import path from "path";
import { createHonoApp } from "../server/app.js";
import log from "electron-log";
import { updateElectronApp } from "update-electron-app";
import { registerListeners } from "./ipc/listeners-register.js";

// Configure logging
log.transports.file.level = "info";
log.transports.console.level = "debug";

// Enable auto-updater
updateElectronApp();

// Set app user model ID for Windows
if (process.platform === "win32") {
  app.setAppUserModelId("com.mcpjam.inspector");
}

let mainWindow: BrowserWindow | null = null;
let server: any = null;
let serverPort: number = 0;

const isDev = process.env.NODE_ENV === "development";

async function findAvailablePort(startPort = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const server = net.createServer();

    server.listen(startPort, () => {
      const port = server.address()?.port;
      server.close(() => {
        resolve(port);
      });
    });

    server.on("error", () => {
      // Port is in use, try next one
      findAvailablePort(startPort + 1)
        .then(resolve)
        .catch(reject);
    });
  });
}

async function startHonoServer(): Promise<number> {
  try {
    const port = await findAvailablePort(3000);

    // Set environment variable to tell the server it's running in Electron
    process.env.ELECTRON_APP = "true";
    process.env.IS_PACKAGED = app.isPackaged ? "true" : "false";
    process.env.ELECTRON_RESOURCES_PATH = process.resourcesPath;

    const honoApp = createHonoApp();

    server = serve({
      fetch: honoApp.fetch,
      port,
      hostname: "127.0.0.1",
    });

    log.info(`🚀 MCPJam Server started on port ${port}`);
    return port;
  } catch (error) {
    log.error("Failed to start Hono server:", error);
    throw error;
  }
}

function createMainWindow(serverUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, "../assets/icon.png"), // You can add an icon later
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Vite plugin outputs main.js and preload.js into the same directory (.vite/build)
      preload: path.join(__dirname, "preload.js"),
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false, // Don't show until ready
  });

  // Load the app
  window.loadURL(isDev ? MAIN_WINDOW_VITE_DEV_SERVER_URL : serverUrl);

  if (isDev) {
    window.webContents.openDevTools();
  }

  // Show window when ready
  window.once("ready-to-show", () => {
    window.show();

    if (isDev) {
      window.webContents.openDevTools();
    }
  });

  // Handle window closed
  window.on("closed", () => {
    mainWindow = null;
  });

  return window;
}

function createAppMenu(): void {
  const isMac = process.platform === "darwin";

  const template: any[] = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideothers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ]
          : []),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// App event handlers
app.whenReady().then(async () => {
  try {
    // Start the embedded Hono server
    serverPort = await startHonoServer();
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    // Create the main window
    createAppMenu();
    mainWindow = createMainWindow(serverUrl);

    // Register IPC listeners
    registerListeners(mainWindow);

    log.info("MCPJam Electron app ready");
  } catch (error) {
    log.error("Failed to initialize app:", error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // Close the server when all windows are closed
  if (server) {
    server.close?.();
    serverPort = 0;
  }

  // On macOS, keep the app running even when all windows are closed
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  // On macOS, re-create window when the dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    if (serverPort > 0) {
      const serverUrl = `http://127.0.0.1:${serverPort}`;
      mainWindow = createMainWindow(serverUrl);
    } else {
      // Restart server if needed
      try {
        serverPort = await startHonoServer();
        const serverUrl = `http://127.0.0.1:${serverPort}`;
        mainWindow = createMainWindow(serverUrl);
      } catch (error) {
        log.error("Failed to restart server:", error);
      }
    }
  }
});

// Security: Prevent new window creation
app.on("web-contents-created", (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
});

// Handle app shutdown
app.on("before-quit", () => {
  if (server) {
    server.close?.();
  }
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
