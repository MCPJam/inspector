/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import * as Sentry from "@sentry/electron/main";
import { electronSentryConfig } from "../shared/sentry-config.js";

Sentry.init({
  ...electronSentryConfig,
  ipcMode: Sentry.IPCMode.Both, // Enables communication with renderer process
});

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

// Register custom protocol for OAuth callbacks
if (!app.isDefaultProtocolClient("mcpjam")) {
  app.setAsDefaultProtocolClient("mcpjam");
}

let mainWindow: BrowserWindow | null = null;
let server: any = null;
let serverPort: number = 0;

const isDev = process.env.NODE_ENV === "development";

async function startHonoServer(): Promise<number> {
  try {
    const port = 6274;
    // Set environment variables to tell the server it's running in Electron
    process.env.ELECTRON_APP = "true";
    process.env.IS_PACKAGED = app.isPackaged ? "true" : "false";
    // In dev mode, use app path (project root), in packaged mode use resourcesPath
    process.env.ELECTRON_RESOURCES_PATH = app.isPackaged
      ? process.resourcesPath
      : app.getAppPath();
    process.env.NODE_ENV = app.isPackaged ? "production" : "development";

    const honoApp = createHonoApp();

    // Bind to 127.0.0.1 when packaged to avoid IPv6-only localhost issues
    const hostname = app.isPackaged ? "127.0.0.1" : "localhost";

    server = serve({
      fetch: honoApp.fetch,
      port,
      hostname,
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

// Handle OAuth callback URLs
app.on("open-url", (event, url) => {
  event.preventDefault();
  log.info("OAuth callback received:", url);

  if (!url.startsWith("mcpjam://oauth/callback")) {
    return;
  }

  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code") ?? "";
    const state = parsed.searchParams.get("state") ?? "";

    // Compute the base URL the renderer should load
    const baseUrl = isDev
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : `http://127.0.0.1:${serverPort}`;

    const callbackUrl = new URL("/callback", baseUrl);
    if (code) callbackUrl.searchParams.set("code", code);
    if (state) callbackUrl.searchParams.set("state", state);

    // Ensure a window exists, then load the callback route directly
    if (!mainWindow) {
      mainWindow = createMainWindow(baseUrl);
    }
    mainWindow.loadURL(callbackUrl.toString());

    // Still emit the event for any listeners
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("oauth-callback", url);
    }

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  } catch (e) {
    log.error("Failed processing OAuth callback URL:", e);
  }
});

// Security: Prevent new window creation, but allow OAuth popups
app.on("web-contents-created", (_, contents) => {
  contents.setWindowOpenHandler(({ url, features }) => {
    try {
      const urlObj = new URL(url);

      // Allow OAuth authorization popups to be created within Electron
      // OAuth authorization URLs are typically external HTTPS URLs
      // Check if this looks like an OAuth flow (external HTTPS URL)
      const isOAuthFlow =
        urlObj.protocol === "https:" &&
        // Common OAuth authorization endpoint patterns
        (urlObj.pathname.includes("/oauth") ||
          urlObj.pathname.includes("/authorize") ||
          urlObj.pathname.includes("/auth") ||
          urlObj.searchParams.has("client_id") ||
          urlObj.searchParams.has("response_type"));

      if (isOAuthFlow) {
        // Parse window features to create popup window
        const width = features?.includes("width=")
          ? parseInt(features.match(/width=(\d+)/)?.[1] || "600")
          : 600;
        const height = features?.includes("height=")
          ? parseInt(features.match(/height=(\d+)/)?.[1] || "700")
          : 700;

        // Create a new BrowserWindow for OAuth popup
        const popup = new BrowserWindow({
          width,
          height,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
          },
          parent: mainWindow || undefined,
          modal: false,
          show: false,
        });

        // Load the OAuth URL
        popup.loadURL(url);

        // Show window when ready
        popup.once("ready-to-show", () => {
          popup.show();
        });

        // Handle OAuth callback redirects
        popup.webContents.on("will-redirect", (event, navigationUrl) => {
          try {
            const redirectUrl = new URL(navigationUrl);
            // If redirecting to our callback URL, handle it
            if (
              redirectUrl.protocol === "mcpjam:" ||
              redirectUrl.pathname.includes("/callback") ||
              redirectUrl.pathname.includes("/oauth/callback")
            ) {
              // Let the redirect happen, the callback handler will process it
              // But we need to ensure the popup can communicate back
            }
          } catch (e) {
            // Invalid URL, ignore
          }
        });

        // Clean up when popup closes
        popup.on("closed", () => {
          // Popup closed, cleanup handled automatically
        });

        return { action: "allow" };
      }

      // For all other URLs, open externally
      shell.openExternal(url);
      return { action: "deny" };
    } catch (e) {
      // If URL parsing fails, open externally as fallback
      shell.openExternal(url);
      return { action: "deny" };
    }
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
