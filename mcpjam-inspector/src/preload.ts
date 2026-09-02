import { contextBridge, ipcRenderer } from "electron";

// Mirror of the main-process UpdateStatus union (kept inline to avoid a shared module).
type UpdateStatus =
  | { kind: "idle" }
  | { kind: "pending"; version?: string; installRequested: boolean }
  | { kind: "downloaded"; version: string; releaseNotes?: string };

// Define the API interface
interface ElectronAPI {
  // App metadata
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<string>;
    openExternal: (url: string) => Promise<void>;
  };

  // File operations
  files: {
    openDialog: (options?: any) => Promise<string[] | undefined>;
    saveDialog: (data: any) => Promise<string | undefined>;
    showMessageBox: (options: any) => Promise<any>;
  };

  /**
   * Local harness. `pickWorkspace` opens the OS directory dialog in the MAIN
   * process and registers what the user chose, returning an opaque grant id and
   * a tilde-shortened display root. The renderer never sees or sends a path —
   * if it could name one, anything that can drive the renderer could name `/`.
   */
  localHarness: {
    pickWorkspace: () => Promise<{
      workspaceGrantId: string;
      displayRoot: string;
    } | null>;
    keystoreAvailable: () => Promise<boolean>;
  };

  // Window operations
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
  };

  // MCP operations (for future use)
  mcp: {
    connect: (config: any) => Promise<any>;
    disconnect: (id: string) => Promise<void>;
    listServers: () => Promise<any[]>;
  };

  // OAuth operations
  oauth: {
    onCallback: (callback: (url: string) => void) => void;
    removeCallback: () => void;
  };

  // Update operations
  update: {
    onUpdateStatus: (callback: (status: UpdateStatus) => void) => void;
    removeUpdateStatusListener: () => void;
    onUpdateError: (callback: () => void) => void;
    removeUpdateErrorListener: () => void;
    getUpdateStatus: () => Promise<UpdateStatus>;
    restartAndInstall: () => void;
    simulateUpdate?: () => void; // Dev only - for testing
    simulateUpdateDownloaded?: () => void; // Dev only - for testing
    simulateUpdateError?: () => void; // Dev only - for testing
  };
}

// Expose protected methods that allow the renderer process to use
const electronAPI: ElectronAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:version"),
    getPlatform: () => ipcRenderer.invoke("app:platform"),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  },

  files: {
    openDialog: (options) => ipcRenderer.invoke("dialog:open", options),
    saveDialog: (data) => ipcRenderer.invoke("dialog:save", data),
    showMessageBox: (options) => ipcRenderer.invoke("dialog:message", options),
  },

  localHarness: {
    pickWorkspace: () => ipcRenderer.invoke("local-harness:pick-workspace"),
    keystoreAvailable: () =>
      ipcRenderer.invoke("local-harness:keystore-available"),
  },

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  },

  mcp: {
    connect: (config) => ipcRenderer.invoke("mcp:connect", config),
    disconnect: (id) => ipcRenderer.invoke("mcp:disconnect", id),
    listServers: () => ipcRenderer.invoke("mcp:list-servers"),
  },

  oauth: {
    onCallback: (callback: (url: string) => void) => {
      ipcRenderer.on("oauth-callback", (_, url: string) => callback(url));
    },
    removeCallback: () => {
      ipcRenderer.removeAllListeners("oauth-callback");
    },
  },

  update: {
    onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
      ipcRenderer.on("update-status", (_, status: UpdateStatus) =>
        callback(status),
      );
    },
    removeUpdateStatusListener: () => {
      ipcRenderer.removeAllListeners("update-status");
    },
    onUpdateError: (callback: () => void) => {
      ipcRenderer.on("update-error", () => callback());
    },
    removeUpdateErrorListener: () => {
      ipcRenderer.removeAllListeners("update-error");
    },
    getUpdateStatus: () => ipcRenderer.invoke("app:get-update-status"),
    restartAndInstall: () => {
      ipcRenderer.send("app:restart-for-update");
    },
    ...(process.env.NODE_ENV === "development"
      ? {
          simulateUpdate: () => {
            ipcRenderer.send("app:simulate-update");
          },
          simulateUpdateDownloaded: () => {
            ipcRenderer.send("app:simulate-update-downloaded");
          },
          simulateUpdateError: () => {
            ipcRenderer.send("app:simulate-update-error");
          },
        }
      : {}),
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

// Also expose a flag to indicate we're running in Electron
contextBridge.exposeInMainWorld("isElectron", true);

/**
 * Whether this is the SHIPPED app rather than a dev run.
 *
 * `isElectron` alone cannot answer that — it is true in dev too — and the two
 * differ on something the renderer has to act on: forge packages `.vite` only,
 * with no `node_modules`, and `playwright` is externalized, so a Playwright
 * browser can never launch in the packaged app. A UI that offered "Chrome
 * window" there would be offering a button that always fails.
 *
 * Read from `process.argv` rather than `process.env`, because a sandboxed
 * preload gets argv (the main window passes `--mcpjam-packaged` through
 * `webPreferences.additionalArguments`) and does not get the main process's
 * environment.
 */
contextBridge.exposeInMainWorld(
  "isElectronPackaged",
  process.argv.includes("--mcpjam-packaged"),
);
