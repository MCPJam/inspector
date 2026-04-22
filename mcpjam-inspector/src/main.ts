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
import { setupAutoUpdaterEvents } from "./ipc/update/update-listeners.js";

// Configure logging
log.transports.file.level = "info";
log.transports.console.level = "debug";

// Enable auto-updater (with custom notification handling)
updateElectronApp({
  notifyUser: false, // We'll show our own UI instead of the default dialog
  logger: log,
});

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
let pendingProtocolUrl: string | null = null;
let appBootstrapped = false;

const isDev = process.env.NODE_ENV === "development";

function getServerUrl(): string {
  return `http://127.0.0.1:${serverPort}`;
}

function getRendererBaseUrl(): string {
  return isDev ? MAIN_WINDOW_VITE_DEV_SERVER_URL : getServerUrl();
}

function findOAuthCallbackUrl(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith("mcpjam://oauth/callback"));
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === "http:" || urlObj.protocol === "https:";
  } catch {
    return false;
  }
}

function isHostedAuthNavigation(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return (
      (urlObj.protocol === "http:" || urlObj.protocol === "https:") &&
      urlObj.pathname.endsWith("/user_management/authorize") &&
      urlObj.searchParams.has("client_id") &&
      urlObj.searchParams.has("redirect_uri") &&
      urlObj.searchParams.get("response_type") === "code"
    );
  } catch {
    return false;
  }
}

function createElectronHostedAuthNavigationUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const rawState = urlObj.searchParams.get("state");
    let parsedState: unknown = undefined;

    if (rawState) {
      try {
        parsedState = JSON.parse(rawState);
      } catch {
        parsedState = rawState;
      }
    }

    const nextState =
      parsedState && typeof parsedState === "object" && !Array.isArray(parsedState)
        ? {
            ...(parsedState as Record<string, unknown>),
            __mcpjam_electron_hosted_auth: true,
          }
        : parsedState === undefined
          ? {
              __mcpjam_electron_hosted_auth: true,
            }
          : {
              __mcpjam_electron_hosted_auth: true,
              originalState: parsedState,
            };

    urlObj.searchParams.set("state", JSON.stringify(nextState));
    return urlObj.toString();
  } catch {
    return url;
  }
}

function buildRendererCallbackUrl(
  callbackUrl: URL,
  baseUrl: string,
): URL | null {
  const flow = callbackUrl.searchParams.get("flow");

  if (flow === "debug") {
    return null;
  }

  const rendererPath = flow === "mcp" ? "/oauth/callback" : "/callback";
  const rendererUrl = new URL(rendererPath, baseUrl);

  for (const [key, value] of callbackUrl.searchParams.entries()) {
    if (key === "flow") continue;
    rendererUrl.searchParams.append(key, value);
  }

  return rendererUrl;
}

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
    show: false, // Don't show until ready
  });

  // Load the app
  window.loadURL(isDev ? MAIN_WINDOW_VITE_DEV_SERVER_URL : serverUrl);

  if (isDev) {
    window.webContents.openDevTools();
  }

  const maybeOpenExternalNavigation = (
    event: { preventDefault: () => void },
    url: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || !isHostedAuthNavigation(url)) {
      return;
    }

    log.info("Opening hosted auth in system browser");
    event.preventDefault();
    void shell.openExternal(createElectronHostedAuthNavigationUrl(url));
  };

  window.webContents.on(
    "will-navigate",
    (event, url, _isInPlace, isMainFrame) => {
      maybeOpenExternalNavigation(event, url, isMainFrame);
    },
  );

  window.webContents.on(
    "will-redirect",
    (event, url, _isInPlace, isMainFrame) => {
      maybeOpenExternalNavigation(event, url, isMainFrame);
    },
  );

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

async function handleOAuthCallbackUrl(url: string): Promise<void> {
  if (!url.startsWith("mcpjam://oauth/callback")) {
    return;
  }

  if (!appBootstrapped) {
    pendingProtocolUrl = url;
    return;
  }

  try {
    log.info("OAuth callback received");

    const parsed = new URL(url);
    const callbackFlow = parsed.searchParams.get("flow");
    const hadMainWindow = Boolean(mainWindow);

    if (serverPort === 0) {
      serverPort = await startHonoServer();
    }

    const baseUrl = getRendererBaseUrl();
    const rendererCallbackUrl = buildRendererCallbackUrl(parsed, baseUrl);

    if (!mainWindow) {
      if (rendererCallbackUrl) {
        mainWindow = createMainWindow(baseUrl);
        mainWindow.loadURL(rendererCallbackUrl.toString());
      } else {
        const debugCallbackUrl = new URL("/oauth/callback/debug", baseUrl);
        for (const [key, value] of parsed.searchParams.entries()) {
          if (key === "flow") continue;
          debugCallbackUrl.searchParams.append(key, value);
        }
        mainWindow = createMainWindow(baseUrl);
        mainWindow.loadURL(debugCallbackUrl.toString());
      }
    } else if (rendererCallbackUrl) {
      mainWindow.loadURL(rendererCallbackUrl.toString());
    }

    if (mainWindow?.webContents && callbackFlow === "debug" && hadMainWindow) {
      mainWindow.webContents.send("oauth-callback", url);
    } else if (
      mainWindow?.webContents &&
      callbackFlow !== "mcp" &&
      callbackFlow !== "debug"
    ) {
      mainWindow.webContents.send("oauth-callback", url);
    }

    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  } catch (error) {
    log.error("Failed processing OAuth callback URL:", error);
  }
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
    const serverUrl = getServerUrl();

    // Create the main window
    createAppMenu();
    mainWindow = createMainWindow(serverUrl);

    // Register IPC listeners
    registerListeners(mainWindow, () => mainWindow);

    // Setup auto-updater events to notify renderer when update is ready
    setupAutoUpdaterEvents(mainWindow);

    appBootstrapped = true;

    if (pendingProtocolUrl) {
      const protocolUrl = pendingProtocolUrl;
      pendingProtocolUrl = null;
      await handleOAuthCallbackUrl(protocolUrl);
    }

    if (process.platform !== "darwin") {
      const protocolUrl = findOAuthCallbackUrl(process.argv);
      if (protocolUrl) {
        await handleOAuthCallbackUrl(protocolUrl);
      }
    }

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
      mainWindow = createMainWindow(getServerUrl());
    } else {
      // Restart server if needed
      try {
        serverPort = await startHonoServer();
        mainWindow = createMainWindow(getServerUrl());
      } catch (error) {
        log.error("Failed to restart server:", error);
      }
    }
  }
});

// Handle OAuth callback URLs
app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleOAuthCallbackUrl(url);
});

// Security: Prevent new window creation, but allow OAuth popups
app.on("web-contents-created", (_, contents) => {
  contents.setWindowOpenHandler(({ url, frameName }) => {
    try {
      // The OAuth debugger popup explicitly names its window with the
      // `oauth_authorization_` prefix so it can keep window.opener semantics.
      if (frameName.startsWith("oauth_authorization_")) {
        return {
          action: "allow",
          createWindow: (options) => {
            const popup = new BrowserWindow({
              ...options,
              parent: mainWindow || undefined,
              modal: false,
              show: false,
              webPreferences: {
                ...options.webPreferences,
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, "preload.js"),
              },
            });

            popup.once("ready-to-show", () => {
              popup.show();
            });

            return popup.webContents;
          },
        };
      }

      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      } else {
        log.warn("Refusing to open non-HTTP URL from window.open");
      }
      return { action: "deny" };
    } catch (error) {
      // Invalid URLs are denied to avoid passing unsafe schemes to the shell.
      log.error("Failed handling window.open URL:", error);
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
  app.on("second-instance", (_event, argv) => {
    const protocolUrl = findOAuthCallbackUrl(argv);
    if (protocolUrl) {
      void handleOAuthCallbackUrl(protocolUrl);
    }

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
