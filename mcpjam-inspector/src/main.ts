/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import * as Sentry from "@sentry/electron/main";
import { electronSentryConfig } from "../shared/sentry-config.js";

Sentry.init({
  ...electronSentryConfig,
  ipcMode: Sentry.IPCMode.Both, // Enables communication with renderer process
});

import { app, BrowserWindow, shell, Menu, dialog } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import path from "path";
import fs from "fs";
import { createHonoApp } from "../server/app.js";
import { tryListenWithFallback } from "./server-port-fallback.js";
import log from "electron-log";
import { updateElectronApp } from "update-electron-app";
import { registerListeners } from "./ipc/listeners-register.js";
import {
  installUpdateOnQuit,
  setTrustedUpdateWindow,
  setupAutoUpdaterEvents,
} from "./ipc/update/update-listeners.js";
import {
  buildProtocolOAuthCallbackUrl,
  buildRendererCallbackUrl,
  ELECTRON_HOSTED_AUTH_STATE_KEY,
  isElectronMcpCallbackUrl,
} from "./oauth-callback-routing.js";

// Configure logging
log.transports.file.level = "info";
log.transports.console.level = "debug";

// Wire autoUpdater event handlers BEFORE update-electron-app starts polling,
// otherwise an early `update-available` event could fire before our listener exists.
setupAutoUpdaterEvents();

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

function shouldForceElectronOAuthFallback(): boolean {
  return (
    !app.isPackaged &&
    process.env.MCPJAM_FORCE_ELECTRON_OAUTH_FALLBACK === "true"
  );
}

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

function isRendererAppNavigation(url: string): boolean {
  try {
    return new URL(url).origin === new URL(getRendererBaseUrl()).origin;
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
      parsedState &&
      typeof parsedState === "object" &&
      !Array.isArray(parsedState)
        ? {
            ...(parsedState as Record<string, unknown>),
            [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
          }
        : parsedState === undefined
        ? {
            [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
          }
        : {
            [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
            originalState: parsedState,
          };

    urlObj.searchParams.set("state", JSON.stringify(nextState));
    return urlObj.toString();
  } catch {
    return url;
  }
}

function installSafeOAuthCallbackRouting(
  authWindow: BrowserWindow,
  source: string
): void {
  const routeIfOAuthCallback = (
    event: { preventDefault: () => void },
    url: string,
    isMainFrame?: boolean
  ) => {
    if (isMainFrame === false) {
      return;
    }

    const protocolCallbackUrl = buildProtocolOAuthCallbackUrl(
      url,
      getRendererBaseUrl()
    );
    if (!protocolCallbackUrl) {
      return;
    }

    event.preventDefault();
    log.info(`Routing ${source} OAuth callback back to MCPJam Desktop`);
    void handleOAuthCallbackUrl(protocolCallbackUrl).finally(() => {
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
    });
  };

  authWindow.webContents.on(
    "will-navigate",
    (event, url, _isInPlace, isMainFrame) => {
      routeIfOAuthCallback(event, url, isMainFrame);
    }
  );

  authWindow.webContents.on(
    "will-redirect",
    (event, url, _isInPlace, isMainFrame) => {
      routeIfOAuthCallback(event, url, isMainFrame);
    }
  );
}

function createSafeOAuthWindow(
  options: BrowserWindowConstructorOptions = {},
  source = "Electron fallback"
): BrowserWindow {
  const { webPreferences: _unsafeWebPreferences, ...safeOptions } = options;
  const authWindow = new BrowserWindow({
    width: 600,
    height: 760,
    ...safeOptions,
    parent: safeOptions.parent ?? mainWindow ?? undefined,
    modal: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  installSafeOAuthCallbackRouting(authWindow, source);

  authWindow.once("ready-to-show", () => {
    authWindow.show();
  });

  return authWindow;
}

function openSafeOAuthWindow(
  url: string,
  parent: BrowserWindow | null,
  source: string
): void {
  const authWindow = createSafeOAuthWindow(
    {
      parent: parent ?? undefined,
    },
    source
  );

  void authWindow.loadURL(url).catch((error) => {
    log.error(`Failed to load ${source} OAuth fallback window:`, error);
    if (!authWindow.isDestroyed()) {
      authWindow.close();
    }
  });
}

const DEFAULT_SERVER_PORT = 6274;
const SERVER_PORT_FALLBACK_ATTEMPTS = 10;

async function startHonoServer(): Promise<number> {
  try {
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

    const { server: boundServer, port } = await tryListenWithFallback(
      honoApp,
      hostname,
      DEFAULT_SERVER_PORT,
      SERVER_PORT_FALLBACK_ATTEMPTS,
      {
        onAttemptFailed: (failedPort, err) => {
          log.warn(
            `Port ${failedPort} unavailable (${err.code ?? err.message}); trying next port`,
          );
        },
      },
    );

    server = boundServer;

    if (port !== DEFAULT_SERVER_PORT) {
      log.warn(
        `🚀 MCPJam Server started on fallback port ${port} (default ${DEFAULT_SERVER_PORT} was unavailable)`,
      );
    } else {
      log.info(`🚀 MCPJam Server started on port ${port}`);
    }
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
    isMainFrame: boolean
  ) => {
    if (!isMainFrame) {
      return;
    }

    if (isHostedAuthNavigation(url)) {
      log.info("Opening hosted auth in system browser");
      event.preventDefault();
      const hostedAuthUrl = createElectronHostedAuthNavigationUrl(url);
      const openExternalPromise = shouldForceElectronOAuthFallback()
        ? Promise.reject(
            new Error("Forced open-external failure for OAuth fallback test")
          )
        : shell.openExternal(hostedAuthUrl);

      void openExternalPromise.catch((error) => {
        log.warn(
          "Failed to open hosted auth in system browser; continuing in a safe Electron auth window:",
          error
        );
        openSafeOAuthWindow(hostedAuthUrl, window, "hosted auth");
      });
      return;
    }

    if (isRendererAppNavigation(url)) {
      return;
    }

    if (!isSafeExternalUrl(url)) {
      log.warn("Blocking unsafe navigation from main window");
      event.preventDefault();
      return;
    }

    log.info("Opening external navigation in system browser");
    event.preventDefault();
    const openExternalPromise = shouldForceElectronOAuthFallback()
      ? Promise.reject(
          new Error("Forced open-external failure for OAuth fallback test")
        )
      : shell.openExternal(url);

    void openExternalPromise.catch((error) => {
      log.warn(
        "Failed to open external navigation in system browser; continuing in a safe Electron window:",
        error
      );
      openSafeOAuthWindow(url, window, "external navigation");
    });
  };

  window.webContents.on(
    "will-navigate",
    (event, url, _isInPlace, isMainFrame) => {
      maybeOpenExternalNavigation(event, url, isMainFrame);
    }
  );

  window.webContents.on(
    "will-redirect",
    (event, url, _isInPlace, isMainFrame) => {
      maybeOpenExternalNavigation(event, url, isMainFrame);
    }
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
    const isMcpCallback = isElectronMcpCallbackUrl(parsed);
    const hadMainWindow = Boolean(mainWindow);

    if (serverPort === 0) {
      serverPort = await startHonoServer();
    }

    const baseUrl = getRendererBaseUrl();
    const rendererCallbackUrl = buildRendererCallbackUrl(parsed, baseUrl);

    if (!mainWindow) {
      if (rendererCallbackUrl) {
        mainWindow = createMainWindow(baseUrl);
        setTrustedUpdateWindow(mainWindow);
        mainWindow.loadURL(rendererCallbackUrl.toString());
      } else {
        const debugCallbackUrl = new URL("/oauth/callback/debug", baseUrl);
        for (const [key, value] of parsed.searchParams.entries()) {
          if (key === "flow") continue;
          debugCallbackUrl.searchParams.append(key, value);
        }
        mainWindow = createMainWindow(baseUrl);
        setTrustedUpdateWindow(mainWindow);
        mainWindow.loadURL(debugCallbackUrl.toString());
      }
    } else if (rendererCallbackUrl) {
      mainWindow.loadURL(rendererCallbackUrl.toString());
    }

    if (mainWindow?.webContents && callbackFlow === "debug" && hadMainWindow) {
      mainWindow.webContents.send("oauth-callback", url);
    } else if (
      mainWindow?.webContents &&
      !isMcpCallback &&
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

function pruneStaleCachesOnVersionChange(): void {
  // Dev launches change app version constantly with HMR/refresh; skip there.
  if (!app.isPackaged) return;

  const userData = app.getPath("userData");
  const versionFile = path.join(userData, ".last-launched-version");
  const currentVersion = app.getVersion();

  let previousVersion: string | null = null;
  try {
    previousVersion = fs.readFileSync(versionFile, "utf8").trim();
  } catch {
    previousVersion = null;
  }

  if (previousVersion === currentVersion) {
    return;
  }

  log.info(
    `App version changed (${previousVersion ?? "<none>"} → ${currentVersion}); pruning stale GPU/HTTP caches`,
  );

  for (const sub of ["Cache", "Code Cache", "GPUCache"]) {
    try {
      fs.rmSync(path.join(userData, sub), { recursive: true, force: true });
    } catch (err) {
      log.warn(`Failed to prune ${sub} during version-change cleanup:`, err);
    }
  }

  try {
    fs.writeFileSync(versionFile, currentVersion);
  } catch (err) {
    log.warn("Failed to persist .last-launched-version marker:", err);
  }
}

function summarizeInitError(error: unknown): {
  message: string;
  detail: string;
} {
  const err =
    error instanceof Error ? error : new Error(String(error ?? "Unknown error"));

  const isServerStartFailure = /bind server|EADDRINUSE|Hono/i.test(err.message);
  const message = isServerStartFailure
    ? "Couldn't start the internal server."
    : "Initialization failed.";

  const logsPath = (() => {
    try {
      return app.getPath("logs");
    } catch {
      return "(logs path unavailable)";
    }
  })();

  const detail = `${err.message}\n\nLogs: ${logsPath}`;
  return { message, detail };
}

function showStartupFailureDialog(error: unknown): void {
  const { message, detail } = summarizeInitError(error);

  const choice = dialog.showMessageBoxSync({
    type: "error",
    title: "MCPJam Inspector failed to start",
    message,
    detail,
    buttons: ["Reset app data and quit", "Open logs folder", "Quit"],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  });

  if (choice === 0) {
    const userData = app.getPath("userData");
    for (const sub of ["Cache", "Code Cache", "GPUCache", "Local Storage"]) {
      try {
        fs.rmSync(path.join(userData, sub), { recursive: true, force: true });
        log.info(`Removed ${sub} during recovery reset`);
      } catch (rmErr) {
        log.warn(`Failed to remove ${sub} during recovery reset:`, rmErr);
      }
    }
    app.relaunch();
    app.quit();
    return;
  }

  if (choice === 1) {
    try {
      void shell.openPath(app.getPath("logs"));
    } catch (openErr) {
      log.warn("Failed to open logs folder:", openErr);
    }
    app.quit();
    return;
  }

  app.quit();
}

// App event handlers
app.whenReady().then(async () => {
  try {
    // Best-effort cleanup of GPU/HTTP caches when the app version changes.
    // Stale caches from a previous build can crash the renderer/GPU process
    // on launch after an auto-update.
    try {
      pruneStaleCachesOnVersionChange();
    } catch (err) {
      log.warn("pruneStaleCachesOnVersionChange threw; continuing:", err);
    }

    // Start the embedded Hono server
    serverPort = await startHonoServer();
    const serverUrl = getServerUrl();

    // Create the main window
    createAppMenu();
    mainWindow = createMainWindow(serverUrl);

    // Register IPC listeners
    registerListeners(mainWindow, () => mainWindow);

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
    try {
      showStartupFailureDialog(error);
    } catch (dialogErr) {
      log.error(
        "Failed to show startup failure dialog; quitting silently:",
        dialogErr,
      );
      app.quit();
    }
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
      setTrustedUpdateWindow(mainWindow);
    } else {
      // Restart server if needed
      try {
        serverPort = await startHonoServer();
        mainWindow = createMainWindow(getServerUrl());
        setTrustedUpdateWindow(mainWindow);
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
            const popup = createSafeOAuthWindow(
              {
                ...options,
                parent: mainWindow || undefined,
              },
              "OAuth popup"
            );

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
app.on("before-quit", (event) => {
  // Safety net: if a new build has been downloaded but the user never clicked the
  // button, install it during quit so the next launch is on the new version.
  // quitAndInstall() re-fires before-quit; the helper guards with isQuittingForUpdate
  // so the second pass falls through and we still close the server.
  if (installUpdateOnQuit()) {
    event.preventDefault();
    return;
  }
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
