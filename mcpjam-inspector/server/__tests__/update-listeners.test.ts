import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  appHandlers,
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
  const appHandlers = new Map<string, Array<(...args: any[]) => void>>();
  const appState = {
    isPackaged: true,
    on: (event: string, handler: (...args: any[]) => void) => {
      const handlers = appHandlers.get(event) ?? [];
      handlers.push(handler);
      appHandlers.set(event, handlers);
    },
  };
  const autoUpdaterHandlers = new Map<
    string,
    Array<(...args: any[]) => void>
  >();
  const ipcHandlers = new Map<string, (...args: any[]) => any>();
  const ipcListeners = new Map<string, (...args: any[]) => void>();
  const windows: any[] = [];

  return {
    appHandlers,
    appState,
    autoUpdaterHandlers,
    checkForUpdatesMock: vi.fn(),
    getAllWindowsMock: vi.fn(() => windows),
    ipcHandleMock: vi.fn(
      (channel: string, handler: (...args: any[]) => any) => {
        ipcHandlers.set(channel, handler);
      },
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

function errorBroadcastCount(window: ReturnType<typeof createWindow>) {
  return window.webContents.send.mock.calls.filter(
    ([channel]) => channel === "update-error",
  ).length;
}

function emitAutoUpdaterEvent(event: string, ...args: any[]) {
  for (const handler of autoUpdaterHandlers.get(event) ?? []) {
    handler(...args);
  }
}

function emitAppEvent(event: string, ...args: any[]) {
  for (const handler of appHandlers.get(event) ?? []) {
    handler(...args);
  }
}

type UpdateListenersModule =
  typeof import("../../src/ipc/update/update-listeners.js");
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
    appHandlers.clear();
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
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
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

  it("lets the user retry checkForUpdates after the watchdog fires", async () => {
    // Regression: bugbot flagged that holding `isCheckingOrDownloading` true
    // after the watchdog blocks in-app retry, because the pending-click
    // path skips `checkForUpdates` while that flag is set. Watchdog must
    // clear it so a follow-up Update click triggers a fresh Squirrel check.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledInstallTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      // First checkForUpdates call fires on update-available via
      // update-electron-app's polling path; that's outside our handler.
      // Our handler only re-calls it on user-click while !isChecking.
      checkForUpdatesMock.mockClear();

      // Watchdog fires.
      vi.advanceTimersByTime(1_000);

      // User clicks Update again — should re-trigger checkForUpdates.
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards installUpdateOnQuit against quitAndInstall throws", async () => {
    appState.isPackaged = true;
    const window = createWindow();
    windows.push(window);
    const { installUpdateOnQuit, registerUpdateListeners } =
      await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");

    // Simulate the macOS Squirrel staging failure at quit time.
    quitAndInstallMock.mockImplementationOnce(() => {
      throw new Error("simulated quitAndInstall failure");
    });

    expect(() => installUpdateOnQuit()).not.toThrow();
    // Returned false so the caller falls through to the normal quit path
    // instead of being trapped in event.preventDefault().
    expect(installUpdateOnQuit()).toBe(true);
    // ^ second call: the previous throw cleared `isQuittingForUpdate`, and
    // status is still "downloaded", so the second call re-enters and this
    // time quitAndInstall doesn't throw (mockImplementationOnce). Returns true.
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

  it("surfaces an error when quitAndInstall returns without quitting", async () => {
    // The reported bug: Squirrel.Mac no-ops instead of throwing when it can't
    // swap in the staged build, so the user clicks Update and gets nothing —
    // no restart, no toast, no log line.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");

      // quitAndInstall returns normally and the app just... keeps running.
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
      expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");

      vi.advanceTimersByTime(1_000);

      expect(window.webContents.send).toHaveBeenCalledWith("update-error");
      // The staged build is still there, so the button stays actionable and a
      // retry is not blocked by a stuck isQuittingForUpdate.
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      expect(quitAndInstallMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-report a silent install after the retry throws", async () => {
    // First click no-ops and arms the quit watchdog; the retry throws and
    // reports right away. The armed watchdog must not fire a second error for
    // a request that already failed.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");

      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      vi.advanceTimersByTime(400);

      quitAndInstallMock.mockImplementationOnce(() => {
        throw new Error("squirrel: staging dir missing");
      });
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      expect(errorBroadcastCount(window)).toBe(1);

      vi.advanceTimersByTime(5_000);

      expect(errorBroadcastCount(window)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not toast twice when Squirrel reports the failure after the watchdog", async () => {
    // The mirror of the case below: the watchdog reports first, then Squirrel
    // explains itself. In a packaged build the error handler notifies
    // unconditionally, so without a guard the user gets two toasts for one
    // dead install.
    vi.useFakeTimers();
    try {
      appState.isPackaged = true;
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      vi.advanceTimersByTime(1_000);
      expect(errorBroadcastCount(window)).toBe(1);

      emitAutoUpdaterEvent("error", new Error("squirrel: Team ID mismatch"));

      expect(errorBroadcastCount(window)).toBe(1);
      expect(logErrorMock).toHaveBeenCalledWith(
        "Auto-updater error:",
        expect.any(Error),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports an unrelated error after a later check", async () => {
    // The suppression above must not outlive the install attempt: a fresh
    // check starts a new cycle, and its failure is the user's to see.
    vi.useFakeTimers();
    try {
      appState.isPackaged = true;
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      vi.advanceTimersByTime(1_000);
      expect(errorBroadcastCount(window)).toBe(1);

      emitAutoUpdaterEvent("checking-for-update");
      emitAutoUpdaterEvent("error", new Error("network died"));

      expect(errorBroadcastCount(window)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when quitAndInstall actually starts the quit", async () => {
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      // Squirrel took the request and the shutdown sequence began.
      emitAppEvent("before-quit");
      vi.advanceTimersByTime(5_000);

      expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still catches a silent refusal that happens after the windows close", async () => {
    // The macOS sequence: quitAndInstall() closes every window and only then
    // reaches Squirrel, so `window-all-closed` fires on the refusing path too.
    // Treating it as an all-clear would disarm the watchdog one step before
    // the refusal it exists to catch.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      // Electron closes the windows, then Squirrel silently refuses.
      emitAppEvent("window-all-closed");
      windows.splice(0, windows.length);
      vi.advanceTimersByTime(1_000);

      // Nobody left to toast, but the session must not go dark: this line
      // plus a still-running process is the whole fingerprint of the bug.
      expect(logWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("no window remains"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not toast a slow shutdown that already closed its windows", async () => {
    // The false positive the warn-level path buys us: a working macOS install
    // is mid-shutdown with its windows gone. No error, no toast.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      windows.splice(0, windows.length);
      vi.advanceTimersByTime(5_000);

      expect(errorBroadcastCount(window)).toBe(0);
      expect(logErrorMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not double-report when the auto-updater reports its own error", async () => {
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setInstallQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      emitAutoUpdaterEvent("error", new Error("install failed"));
      const afterReportedError = (
        window.webContents.send as any
      ).mock.calls.filter(
        ([channel]: [string]) => channel === "update-error",
      ).length;

      vi.advanceTimersByTime(2_000);

      const afterWatchdogWindow = (
        window.webContents.send as any
      ).mock.calls.filter(
        ([channel]: [string]) => channel === "update-error",
      ).length;
      expect(afterReportedError).toBe(1);
      expect(afterWatchdogWindow).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The reported session, reproduced: the recording shows the pill going into
  // "Updating…" on EVERY click, which pins the state to `pending` — the state
  // the quit watchdog above never sees, because no install is ever staged.
  it("reports the failure when no update is available mid-install", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    emitAutoUpdaterEvent("update-not-available");

    // The spinner unsticks, the button stays visible, and — the fix — the user
    // is told, instead of being handed a live button that does this forever.
    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "pending",
      installRequested: false,
    });
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("stays quiet when a background check finds nothing", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");

    // Nobody clicked. Squirrel polls every 10 minutes, so this answer is
    // routine here and must not toast — that's the difference the fix draws.
    emitAutoUpdaterEvent("update-not-available");

    expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
    expect(window.webContents.send).toHaveBeenLastCalledWith("update-status", {
      kind: "pending",
      installRequested: false,
    });
  });

  it("still lets the user retry after a no-update-available report", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("update-not-available");

    // Second click: `isCheckingOrDownloading` was cleared, so this one must
    // reach Squirrel rather than queueing behind a check that already ended.
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenLastCalledWith("update-status", {
      kind: "pending",
      installRequested: true,
    });
  });
});
