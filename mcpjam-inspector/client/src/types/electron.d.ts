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

  /**
   * The agent's browser as a REAL view, not a picture of one.
   *
   * On the desktop app the browser is a `WebContentsView` in the main process,
   * so the pane asks that process to parent it into the app's own window at the
   * rail's bounds rather than watching a JPEG screencast of a page this machine
   * already has. The renderer names a boot id and a rectangle and nothing else.
   *
   * OPTIONAL, and the pane must check: this is `undefined` in the browser, and
   * also in a desktop app older than this wave, and both must fall back to
   * frames rather than render a rail that never paints.
   */
  agentBrowser?: {
    /** Can this build show a native view at all? Asked before any browser. */
    capability: () => Promise<{ available: boolean }>;
    /**
     * Ask for the view to be at these bounds, or taken off screen.
     *
     * `visible: true` is a REQUEST. The daemon's lease decides, and the answer
     * says what actually happened — `shown: false` with `reason: "lease"` is
     * somebody else holding this browser, which is not an error.
     */
    setViewport: (request: {
      bootId: string;
      holder?: string;
      visible: boolean;
      bounds?: { x: number; y: number; width: number; height: number };
    }) => Promise<{
      shown: boolean;
      inputAllowed: boolean;
      reason?: "unknown" | "no_window" | "bad_bounds" | "lease";
    }>;
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
    /**
     * True only in the SHIPPED desktop app, never in a dev run — which
     * `isElectron` cannot distinguish. Set from `--mcpjam-packaged` in
     * `process.argv` by the preload.
     */
    isElectronPackaged?: boolean;
  }
}

export {};
