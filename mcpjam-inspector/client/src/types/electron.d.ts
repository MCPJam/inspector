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

  /**
   * Local harness. `pickWorkspace` opens the OS directory dialog in the MAIN
   * process and registers what the user chose, returning an opaque grant id
   * and a tilde-shortened display root. The renderer never sees or sends a
   * path — if it could name one, anything that can drive the renderer could
   * name `/`.
   *
   * Optional: the npx build has no `electronAPI` at all, and a packaged app
   * older than this preload would not carry the namespace either.
   */
  localHarness?: {
    pickWorkspace: () => Promise<{
      workspaceGrantId: string;
      displayRoot: string;
    } | null>;
    keystoreAvailable: () => Promise<boolean>;
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
    /**
     * True only in the SHIPPED desktop app, never in a dev run — which
     * `isElectron` cannot distinguish. Set from `--mcpjam-packaged` in
     * `process.argv` by the preload.
     */
    isElectronPackaged?: boolean;
  }
}

export {};
