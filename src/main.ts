import { app, BrowserWindow, shell, Menu } from 'electron';
import { serve } from '@hono/node-server';
import path from 'path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import log from 'electron-log';
import { updateElectronApp } from 'update-electron-app';
import { registerListeners } from './ipc/listeners-register.js';

// Configure logging
log.transports.file.level = 'debug';
log.transports.console.level = 'debug';

// Log to both file and console for better debugging
log.info('=== MCPJam Inspector Starting ===');
log.info(`Platform: ${process.platform}`);
log.info(`Node version: ${process.version}`);
log.info(`Electron version: ${process.versions.electron}`);
log.info(`App packaged: ${app.isPackaged}`);

// Enable auto-updater
updateElectronApp();

// Set app user model ID for Windows
if (process.platform === 'win32') {
  app.setAppUserModelId('com.mcpjam.inspector');
}

let mainWindow: BrowserWindow | null = null;
let server: any = null;
let serverPort: number = 0;

const isDev = process.env.NODE_ENV === 'development';

function createSimpleHonoApp() {
  const app = new Hono();

  // Middleware
  app.use("*", logger());
  app.use("*", cors({
    origin: [
      "http://localhost:8080",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:3000",
    ],
    credentials: true,
  }));

  // Health check
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Debug endpoint - for development debugging
  app.get("/debug/info", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      environment: {
        isPackaged: app.isPackaged,
        nodeEnv: process.env.NODE_ENV,
        platform: process.platform,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node
      }
    });
  });

  // Static file serving - only in development
  // In production, renderer is loaded via Electron's loadFile()
  if (!app.isPackaged) {
    const clientPath = "./dist/renderer";
    console.log(`[DEBUG] Dev mode: serving static files from: ${clientPath}`);
    app.use("/*", serveStatic({ root: clientPath }));

    // SPA fallback for development
    app.get("*", (c) => {
      const requestPath = c.req.path;
      if (requestPath.startsWith("/api/") || requestPath.startsWith("/debug/")) {
        return c.notFound();
      }
      return serveStatic({ path: "./dist/renderer/index.html" })(c);
    });
  } else {
    // In packaged app, only serve API routes - renderer handled by Electron
    console.log(`[DEBUG] Packaged mode: server only handles API routes`);
    app.get("*", (c) => {
      const requestPath = c.req.path;
      if (requestPath.startsWith("/api/") || requestPath.startsWith("/debug/") || requestPath.startsWith("/health")) {
        return c.notFound(); // Let other routes handle these
      }
      return c.json({ message: "API server - renderer loaded via Electron loadFile" });
    });
  }

  return app;
}

async function findAvailablePort(startPort = 3001): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer();
    
    server.listen(startPort, () => {
      const port = server.address()?.port;
      server.close(() => {
        resolve(port);
      });
    });
    
    server.on('error', () => {
      // Port is in use, try next one
      findAvailablePort(startPort + 1).then(resolve).catch(reject);
    });
  });
}

async function startHonoServer(): Promise<number> {
  try {
    const port = await findAvailablePort(3001);
    
    // Set environment variable to tell the server it's running in Electron
    process.env.ELECTRON_APP = 'true';
    
    log.info('Creating Hono app...');
    const honoApp = createSimpleHonoApp();
    log.info('Successfully created Hono app');
    
    server = serve({
      fetch: honoApp.fetch,
      port,
      hostname: '127.0.0.1'
    });
    
    log.info(`🚀 MCP Inspector Server started on port ${port}`);
    return port;
  } catch (error) {
    log.error('Failed to start Hono server:', error);
    log.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    log.error('Error name:', error instanceof Error ? error.name : 'Unknown');
    log.error('Error message:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function createMainWindow(serverUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../assets/icon.png'), // You can add an icon later
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, '../build/preload.js'),
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false, // Don't show until ready
  });

  // Register IPC listeners
  registerListeners(window);

  // Load the app with hybrid approach: try Electron loadFile first, fallback to server
  const MAIN_WINDOW_VITE_DEV_SERVER_URL = process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const MAIN_WINDOW_VITE_NAME = process.env.MAIN_WINDOW_VITE_NAME || 'main_window';
  
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    // In development, load from Vite dev server
    window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    // In production, try Electron's loadFile first, fallback to embedded server
    const rendererPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    
    try {
      const fs = require('fs');
      if (fs.existsSync(rendererPath)) {
        // Renderer files found - use Electron's built-in file loading
        window.loadFile(rendererPath);
      } else {
        // Renderer files not found - fallback to embedded server
        log.info('Renderer files not in expected location, using embedded server');
        window.loadURL(serverUrl);
      }
    } catch (error) {
      // Error checking files - fallback to embedded server
      log.warn('Error checking renderer files, using embedded server:', error.message);
      window.loadURL(serverUrl);
    }
  }
  
  // Open DevTools only in development
  if (isDev) {
    window.webContents.openDevTools();
  }

  // Show window when ready
  window.once('ready-to-show', () => {
    window.show();
    
    if (isDev) {
      window.webContents.openDevTools();
    }
  });

  // Handle external links
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle window closed
  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

function createAppMenu(): void {
  const isMac = process.platform === 'darwin';
  
  const template: any[] = [
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideothers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [])
      ]
    }
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
    
    log.info('MCP Inspector Electron app ready');
  } catch (error) {
    log.error('Failed to initialize app:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Close the server when all windows are closed
  if (server) {
    server.close?.();
  }
  
  // On macOS, keep the app running even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
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
        log.error('Failed to restart server:', error);
      }
    }
  }
});

// Security: Prevent new window creation
app.on('web-contents-created', (_, contents) => {
  contents.on('new-window', (navigationEvent, navigationUrl) => {
    navigationEvent.preventDefault();
    shell.openExternal(navigationUrl);
  });
});

// Handle app shutdown
app.on('before-quit', () => {
  if (server) {
    server.close?.();
  }
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}