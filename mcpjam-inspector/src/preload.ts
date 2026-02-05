import { contextBridge, ipcRenderer } from "electron";

// Update info type
interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

// Define the API interface
interface ElectronAPI {
  // App metadata
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<string>;
  };

  // File operations
  files: {
    openDialog: (options?: any) => Promise<string[] | undefined>;
    saveDialog: (data: any) => Promise<string | undefined>;
    showMessageBox: (options: any) => Promise<any>;
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
    onUpdateReady: (callback: (info: UpdateInfo) => void) => void;
    removeUpdateReadyListener: () => void;
    restartAndInstall: () => void;
    simulateUpdate: () => void; // Dev only - for testing
  };
}

// Expose protected methods that allow the renderer process to use
const electronAPI: ElectronAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:version"),
    getPlatform: () => ipcRenderer.invoke("app:platform"),
  },

  files: {
    openDialog: (options) => ipcRenderer.invoke("dialog:open", options),
    saveDialog: (data) => ipcRenderer.invoke("dialog:save", data),
    showMessageBox: (options) => ipcRenderer.invoke("dialog:message", options),
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
    onUpdateReady: (callback: (info: UpdateInfo) => void) => {
      ipcRenderer.on("update-ready", (_, info: UpdateInfo) => callback(info));
    },
    removeUpdateReadyListener: () => {
      ipcRenderer.removeAllListeners("update-ready");
    },
    restartAndInstall: () => {
      ipcRenderer.send("app:restart-for-update");
    },
    simulateUpdate: () => {
      // Dev only - sends a fake update event for testing
      ipcRenderer.send("app:simulate-update");
    },
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

// Also expose a flag to indicate we're running in Electron
contextBridge.exposeInMainWorld("isElectron", true);
