import { contextBridge, ipcRenderer } from 'electron';

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
}

// Expose protected methods that allow the renderer process to use
const electronAPI: ElectronAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    getPlatform: () => ipcRenderer.invoke('app:platform'),
  },
  
  files: {
    openDialog: (options) => ipcRenderer.invoke('dialog:open', options),
    saveDialog: (data) => ipcRenderer.invoke('dialog:save', data),
    showMessageBox: (options) => ipcRenderer.invoke('dialog:message', options),
  },
  
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },
  
  mcp: {
    connect: (config) => ipcRenderer.invoke('mcp:connect', config),
    disconnect: (id) => ipcRenderer.invoke('mcp:disconnect', id),
    listServers: () => ipcRenderer.invoke('mcp:list-servers'),
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Also expose a flag to indicate we're running in Electron
contextBridge.exposeInMainWorld('isElectron', true);