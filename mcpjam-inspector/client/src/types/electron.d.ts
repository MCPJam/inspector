export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "pending"; version?: string; installRequested: boolean }
  | { kind: "downloaded"; version: string; releaseNotes?: string };

export interface ElectronAPI {
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
    simulateUpdate?: () => void;
    simulateUpdateDownloaded?: () => void;
    simulateUpdateError?: () => void;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    isElectron?: boolean;
  }
}

export {};
