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

function emitAutoUpdaterEvent(event: string, ...args: any[]) {
  for (const handler of autoUpdaterHandlers.get(event) ?? []) {
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

  it("retires the update button when update-not-available follows an available update", async () => {
    // THE SHIPPED BUG. `pending` used to be sticky: the button stayed on
    // screen wired to a download that had already died, every click set
    // installRequested, the next updater event cleared it, and the label
    // flickered Update -> Updating… -> Update forever.
    //
    // On macOS these two events are not the matched pair they look like.
    // `update-available` is a KVO side effect of SQRLUpdater entering its
    // Downloading state; `update-not-available` is this check finishing with
    // no downloaded build in hand. A download that starts and then dies
    // without an NSError emits exactly this sequence.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-not-available");

    expect(window.webContents.send).toHaveBeenLastCalledWith("update-status", {
      kind: "idle",
    });
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "idle" });
  });

  it("falls back to a manual download after the second collapsed download", async () => {
    // One collapse can be a dropped connection, so the first drops to idle
    // and the next poll gets a turn. Two is a pattern: this install cannot
    // self-update, and re-arming the in-app button just hands the user
    // something to click that will never work.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-not-available");
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-not-available");

    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "manual",
      version: undefined,
    });
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
  });

  it("does not re-arm the in-app install once the manual fallback is showing", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("update-not-available");
    (window.webContents.send as any).mockClear();

    // update-electron-app keeps polling every 10 minutes.
    emitAutoUpdaterEvent("update-available");

    expect(window.webContents.send).not.toHaveBeenCalledWith(
      "update-status",
      expect.objectContaining({ kind: "pending" }),
    );
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "manual", version: undefined });
  });

  it("lets a download that finally lands override the manual fallback", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("update-not-available");

    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.6.0");

    expect(window.webContents.send).toHaveBeenLastCalledWith(
      "update-status",
      expect.objectContaining({ kind: "downloaded", version: "3.6.0" }),
    );
    // The click that collapsed is long gone, so we do not quit behind the
    // user's back.
    expect(quitAndInstallMock).not.toHaveBeenCalled();
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

  it("retires the button after an updater error instead of leaving it clickable", async () => {
    // Replaces the old "retry from pending" affordance. Offering that retry
    // meant keeping `pending` alive, and a live `pending` with no download
    // behind it is exactly the dead button this fix removes. The next poll
    // re-announces the update if it is still installable.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("error", new Error("download failed"));

    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "idle",
    });

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith(
      "Restart requested but no update is staged",
    );
  });

  it("keeps a slow download alive when the 10-minute poll is refused mid-download", async () => {
    // update-electron-app polls on a blind interval and Squirrel refuses a
    // second check while one is running, so a download slower than 10
    // minutes errors in RACCommandErrorDomain every 10 minutes. That says
    // nothing about the download — collapsing on it would retire a build
    // that was still on its way.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    window.webContents.send.mockClear();

    const refused = Object.assign(new Error("The command is disabled"), {
      domain: "RACCommandErrorDomain",
      code: 1,
    });
    emitAutoUpdaterEvent("error", refused);

    // No collapse, no error toast, and the queued install survives.
    expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
    expect(window.webContents.send).not.toHaveBeenCalledWith(
      "update-status",
      expect.objectContaining({ kind: "manual" }),
    );

    emitAutoUpdaterEvent("update-downloaded", {}, "notes", "3.5.2");

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("still collapses on a real updater error from a different domain", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");

    const real = Object.assign(new Error("staging failed"), {
      domain: "SQRLUpdaterErrorDomain",
      code: 4,
    });
    emitAutoUpdaterEvent("error", real);

    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "idle",
    });
  });

  it("offers a manual download when a user-requested install fails", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    emitAutoUpdaterEvent("error", new Error("download failed"));

    // Someone who clicked gets the answer on the first failure, not the
    // second: the button becomes a link to the releases page.
    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "manual",
      version: undefined,
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

  it("retires a download that never reports anything, even with no click", async () => {
    // The half the click-armed watchdog never covered: `update-available`
    // fires, Squirrel goes quiet, and nobody clicks. Before this the button
    // sat there for the life of the process with nothing behind it.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledDownloadTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");

      expect(window.webContents.send).toHaveBeenLastCalledWith(
        "update-status",
        { kind: "pending", installRequested: false },
      );

      vi.advanceTimersByTime(1_000);

      expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
        kind: "idle",
      });
      expect(window.webContents.send).toHaveBeenCalledWith("update-error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a stale click on the manual fallback back to the error path", async () => {
    // The renderer opens the releases page for `manual`, so this only
    // happens when a click races the status change. Silence is the bug
    // being fixed, so re-broadcast rather than no-op.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("update-not-available");
    (window.webContents.send as any).mockClear();

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
    expect(quitAndInstallMock).not.toHaveBeenCalled();
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

      // Watchdog retires the dead download and hands the user the manual
      // route, rather than parking them back on the same button.
      expect(window.webContents.send).toHaveBeenCalledWith("update-error");
      expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
        kind: "manual",
        version: undefined,
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

  it("ignores a second Update click while the install is already underway", async () => {
    // INSPECTOR-ELECTRON-GT. `quitAndInstall` is not idempotent: with a window
    // still open Electron registers the AutoUpdater on the window list and
    // waits for the windows to close, so a second call re-registers the same
    // observer and Chromium reports "Observers can only be added once!".
    // Nothing clears `downloaded`, so the button stays live for the whole
    // teardown — which is the window a double-click lands in.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeat click after the install started from a queued download", async () => {
    // The other way in: the user clicks while still downloading, so
    // `update-downloaded` starts the install itself. A click after that lands
    // on a `downloaded` status with the quit already in flight.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
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
