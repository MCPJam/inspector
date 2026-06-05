import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  appState,
  autoUpdaterHandlers,
  checkForUpdatesMock,
  getAllWindowsMock,
  ipcHandleMock,
  ipcOnMock,
  ipcHandlers,
  ipcListeners,
  logErrorMock,
  logInfoMock,
  logWarnMock,
  quitAndInstallMock,
  windows,
} = vi.hoisted(() => {
  const appState = { isPackaged: true };
  const autoUpdaterHandlers = new Map<
    string,
    Array<(...args: any[]) => void>
  >();
  const ipcHandlers = new Map<string, (...args: any[]) => any>();
  const ipcListeners = new Map<string, (...args: any[]) => void>();
  const windows: any[] = [];

  return {
    appState,
    autoUpdaterHandlers,
    checkForUpdatesMock: vi.fn(),
    getAllWindowsMock: vi.fn(() => windows),
    ipcHandleMock: vi.fn(
      (channel: string, handler: (...args: any[]) => any) => {
        ipcHandlers.set(channel, handler);
      }
    ),
    ipcOnMock: vi.fn((channel: string, handler: (...args: any[]) => void) => {
      ipcListeners.set(channel, handler);
    }),
    ipcHandlers,
    ipcListeners,
    logErrorMock: vi.fn(),
    logInfoMock: vi.fn(),
    logWarnMock: vi.fn(),
    quitAndInstallMock: vi.fn(),
    windows,
  };
});

vi.mock("electron", () => ({
  app: appState,
  autoUpdater: {
    checkForUpdates: checkForUpdatesMock,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const handlers = autoUpdaterHandlers.get(event) ?? [];
      handlers.push(handler);
      autoUpdaterHandlers.set(event, handlers);
    }),
    quitAndInstall: quitAndInstallMock,
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  ipcMain: {
    handle: ipcHandleMock,
    on: ipcOnMock,
  },
}));

vi.mock("electron-log", () => ({
  default: {
    error: logErrorMock,
    info: logInfoMock,
    warn: logWarnMock,
  },
}));

function createWindow(id = 1) {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id,
      isLoading: vi.fn(() => false),
      once: vi.fn(),
      send: vi.fn(),
    },
  };
}

function emitAutoUpdaterEvent(event: string, ...args: any[]) {
  for (const handler of autoUpdaterHandlers.get(event) ?? []) {
    handler(...args);
  }
}

type UpdateListenersModule = typeof import("../../src/ipc/update/update-listeners.js");
let lastLoadedModule: UpdateListenersModule | null = null;

async function loadUpdateListeners() {
  vi.resetModules();
  const mod = await import("../../src/ipc/update/update-listeners.js");
  mod.setupAutoUpdaterEvents();
  lastLoadedModule = mod;
  return mod;
}

describe("update-listeners", () => {
  beforeEach(() => {
    appState.isPackaged = true;
    autoUpdaterHandlers.clear();
    ipcHandlers.clear();
    ipcListeners.clear();
    windows.splice(0, windows.length);
    checkForUpdatesMock.mockReset();
    quitAndInstallMock.mockReset();
    logErrorMock.mockReset();
    logInfoMock.mockReset();
    logWarnMock.mockReset();
  });

  afterEach(() => {
    // Clear any pending watchdog timer from the previously loaded module
    // so a real 60s setTimeout doesn't leak between tests.
    lastLoadedModule?.__resetUpdateStateForTests();
    lastLoadedModule = null;
  });

  it("keeps the update button visible when update-not-available follows an available update", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-not-available");

    expect(window.webContents.send).toHaveBeenLastCalledWith("update-status", {
      kind: "pending",
      installRequested: false,
    });
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } })
    ).toEqual({ kind: "pending", installRequested: false });
  });

  it("queues install when the user clicks Update while the download is still pending", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenLastCalledWith("update-status", {
      kind: "pending",
      installRequested: true,
    });

    emitAutoUpdaterEvent("update-downloaded", {}, "", "2.4.11");

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("lets the user retry from a pending state after a prior updater error", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("error", new Error("download failed"));

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenLastCalledWith("update-status", {
      kind: "pending",
      installRequested: true,
    });
  });

  it("keeps the button visible and notifies after a user-requested install fails", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    emitAutoUpdaterEvent("error", new Error("download failed"));

    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "pending",
      installRequested: false,
    });
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
  });

  it("does not try to install simulated downloaded updates on quit in dev", async () => {
    appState.isPackaged = false;
    const window = createWindow();
    windows.push(window);
    const { installUpdateOnQuit, registerUpdateListeners } =
      await loadUpdateListeners();

    registerUpdateListeners(window as any);
    ipcListeners.get("app:simulate-update-downloaded")?.({ sender: { id: 1 } });

    expect(installUpdateOnQuit()).toBe(false);
    expect(quitAndInstallMock).not.toHaveBeenCalled();
  });

  it("fires update-error broadcast when stuck in pending+installRequested past the watchdog", async () => {
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledInstallTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      // Before timeout: no error broadcast yet.
      expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");

      vi.advanceTimersByTime(1_000);

      // Watchdog should have reset installRequested and broadcast the error.
      expect(window.webContents.send).toHaveBeenCalledWith("update-error");
      expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
        kind: "pending",
        installRequested: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still surfaces the download to the renderer when it completes AFTER the watchdog fired", async () => {
    // Regression: bugbot flagged that legitimate slow downloads exceeding the
    // watchdog window would be silently dropped. Watchdog should clear
    // installRequested + toast the user, but a later update-downloaded must
    // still flip the status to "downloaded" so the user can click Update
    // again and install. We intentionally do NOT auto-quitAndInstall here,
    // because the user already saw an error toast and may be mid-task.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledInstallTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      // Watchdog fires.
      vi.advanceTimersByTime(1_000);
      expect(window.webContents.send).toHaveBeenCalledWith("update-error");
      (window.webContents.send as any).mockClear();

      // Download finishes much later.
      vi.advanceTimersByTime(10_000);
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");

      // Renderer sees the staged update so the Update button reappears.
      expect(window.webContents.send).toHaveBeenCalledWith(
        "update-status",
        expect.objectContaining({ kind: "downloaded", version: "2.5.0" }),
      );
      // But we don't auto-install behind the user's back.
      expect(quitAndInstallMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the watchdog when update-downloaded fires before timeout", async () => {
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledInstallTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      // Download completes well before the watchdog deadline.
      vi.advanceTimersByTime(200);
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");

      // Now let the original deadline pass — nothing extra should happen.
      vi.advanceTimersByTime(2_000);

      expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
      // quitAndInstall ran (installRequested was true).
      expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("broadcasts update-error in packaged mode even when the user has not clicked", async () => {
    appState.isPackaged = true;
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    // No app:restart-for-update click here — installRequested stays false.
    emitAutoUpdaterEvent("error", new Error("network died"));

    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
  });

  it("does not broadcast update-error in dev when nothing was user-requested", async () => {
    // Sanity: dev simulation path should still respect its tighter rule
    // (the broadcast for plain `error` only fires in packaged mode now).
    appState.isPackaged = false;
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("error", new Error("network died"));

    expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
  });

  it("catches quitAndInstall throws and surfaces an error broadcast", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    quitAndInstallMock.mockImplementationOnce(() => {
      throw new Error("squirrel: staging dir missing");
    });

    registerUpdateListeners(window as any);
    // Drive into `downloaded` state, then click Update.
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");

    // isQuittingForUpdate should not be stuck — a subsequent click should
    // attempt quitAndInstall again (mock no longer throws).
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    expect(quitAndInstallMock).toHaveBeenCalledTimes(2);
  });
});
