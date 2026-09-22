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
  relaunchMock,
  quitMock,
  setFeedURLMock,
  fsState,
  readFileSyncMock,
  writeFileSyncMock,
  rmSyncMock,
  windows,
} = vi.hoisted(() => {
  const appState = {
    isPackaged: true,
    getVersion: () => "3.8.0",
    getPath: (_name: string) => "/tmp/userData",
  };
  // One in-memory file: the relaunch marker. Keyed by path so a stray write
  // somewhere else would show up as a failure rather than silently pass.
  const fsState: { files: Map<string, string> } = { files: new Map() };
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
    relaunchMock: vi.fn(),
    quitMock: vi.fn(),
    setFeedURLMock: vi.fn(),
    fsState,
    readFileSyncMock: vi.fn((file: string) => {
      const value = fsState.files.get(String(file));
      if (value === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return value;
    }),
    writeFileSyncMock: vi.fn((file: string, data: string) => {
      fsState.files.set(String(file), String(data));
    }),
    rmSyncMock: vi.fn((file: string) => {
      fsState.files.delete(String(file));
    }),
    windows,
  };
});

vi.mock("fs", () => ({
  default: {
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
    rmSync: rmSyncMock,
  },
}));

vi.mock("electron", () => ({
  app: Object.assign(appState, { relaunch: relaunchMock, quit: quitMock }),
  autoUpdater: {
    checkForUpdates: checkForUpdatesMock,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const handlers = autoUpdaterHandlers.get(event) ?? [];
      handlers.push(handler);
      autoUpdaterHandlers.set(event, handlers);
    }),
    quitAndInstall: quitAndInstallMock,
    setFeedURL: setFeedURLMock,
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
    relaunchMock.mockReset();
    quitMock.mockReset();
    setFeedURLMock.mockReset();
    writeFileSyncMock.mockClear();
    readFileSyncMock.mockClear();
    rmSyncMock.mockClear();
    fsState.files.clear();
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

  it("keeps a staged build when a later poll re-announces the update", async () => {
    // update-electron-app never stops polling after a download lands, so a
    // `downloaded` status has to survive a fresh `update-available`. Without
    // the guard the poll walked it back to `pending`, and the poll's own
    // `update-not-available` then collapsed it — "Restart to update"
    // vanishing for a build sitting on disk that installs on next launch.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
    (window.webContents.send as any).mockClear();

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-not-available");

    expect(window.webContents.send).not.toHaveBeenCalledWith(
      "update-status",
      expect.objectContaining({ kind: "pending" }),
    );
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual(
      expect.objectContaining({ kind: "downloaded", version: "2.5.0" }),
    );
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

  it("resets the collapse history after a simulated download lands", async () => {
    // The simulated success has to do the real handler's cleanup, or a QA run
    // of failure → success → failure jumps straight to the manual fallback on
    // a collapse count the successful download should have cleared.
    appState.isPackaged = false;
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    ipcListeners.get("app:simulate-update")?.({ sender: { id: 1 } });
    ipcListeners.get("app:simulate-update-error")?.({ sender: { id: 1 } });
    ipcListeners.get("app:simulate-update")?.({ sender: { id: 1 } });
    ipcListeners.get("app:simulate-update-downloaded")?.({ sender: { id: 1 } });

    ipcListeners.get("app:simulate-update")?.({ sender: { id: 1 } });
    ipcListeners.get("app:simulate-update-error")?.({ sender: { id: 1 } });

    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "idle" });
  });

  it("gives the next simulated download a full deadline after one lands", async () => {
    // The simulated success must clear the watchdog too. A leftover deadline
    // is spent time: the next simulated download inherits what is left of it
    // and can collapse almost immediately.
    vi.useFakeTimers();
    try {
      appState.isPackaged = false;
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledDownloadTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      ipcListeners.get("app:simulate-update")?.({ sender: { id: 1 } });
      vi.advanceTimersByTime(600);
      ipcListeners.get("app:simulate-update-downloaded")?.({
        sender: { id: 1 },
      });

      ipcListeners.get("app:simulate-update")?.({ sender: { id: 1 } });
      vi.advanceTimersByTime(500);

      expect(
        ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
      ).toEqual({ kind: "pending", installRequested: false });
    } finally {
      vi.useRealTimers();
    }
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

  it("does not toast twice when a stale click races the manual fallback", async () => {
    // The renderer opens the releases page for `manual`, so a click only
    // arrives here when it raced the status change — and the collapse that
    // set `manual` already broadcast the error, which is what resets the
    // renderer. Repeating it would show two toasts back to back.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("update-not-available");
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
    (window.webContents.send as any).mockClear();

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
    expect(quitAndInstallMock).not.toHaveBeenCalled();
  });

  it("ignores the Windows shape of a refused concurrent check", async () => {
    // Squirrel.Windows refuses the overlapping poll from spawnUpdate with a
    // plain Error — no NSError domain — so a download slower than the
    // 10-minute poll used to be retired on a healthy machine.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    (window.webContents.send as any).mockClear();

    emitAutoUpdaterEvent(
      "error",
      new Error(
        "AutoUpdater process with arguments --checkForUpdate,https://example.test is already running",
      ),
    );

    expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "pending", installRequested: true });

    // The queued install survives, so the slow download still installs.
    emitAutoUpdaterEvent("update-downloaded", {}, "notes", "3.5.2");
    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("offers the manual download when checks stay refused after a collapse", async () => {
    // A download that hangs with no error keeps Squirrel busy forever, so
    // every later poll is refused and `pending` never comes back. Without
    // this the user is left with no button, no toast and no link at all.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-not-available");
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "idle" });
    (window.webContents.send as any).mockClear();

    const refused = Object.assign(new Error("The command is disabled"), {
      domain: "RACCommandErrorDomain",
      code: 1,
    });
    emitAutoUpdaterEvent("error", refused);

    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "manual",
    });
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
  });

  it("stops re-toasting once the manual fallback is showing", async () => {
    // update-electron-app keeps polling every 10 minutes. An install that
    // fails the same way each time must not nag forever — the pill already
    // says where to go.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("error", new Error("staging failed"));
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
    (window.webContents.send as any).mockClear();

    emitAutoUpdaterEvent("error", new Error("staging failed"));

    expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "manual", version: undefined });
  });

  it("collapses a simulated error the same way the real one does", async () => {
    appState.isPackaged = false;
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    ipcListeners.get("app:simulate-update")?.({ sender: { id: 1 } });
    ipcListeners.get("app:simulate-update-error")?.({ sender: { id: 1 } });

    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "idle",
    });

    ipcListeners.get("app:simulate-update")?.({ sender: { id: 1 } });
    ipcListeners.get("app:simulate-update-error")?.({ sender: { id: 1 } });

    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "manual",
      version: undefined,
    });
  });

  it("does not push the stall deadline out when the poll re-announces the update", async () => {
    // update-available on every poll used to re-arm the watchdog, so a stuck
    // download could hold the button for the life of the process.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledDownloadTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");

      vi.advanceTimersByTime(700);
      emitAutoUpdaterEvent("update-available");
      vi.advanceTimersByTime(400);

      expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
        kind: "idle",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not give a slow download extra time because the user clicked", async () => {
    // The click brings the deadline forward at most; it never resets it, so
    // a healthy-but-slow download is not judged by a fresh five minutes
    // starting from whenever the user happened to look at the pill.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledDownloadTimeoutForTests(1_000);
      mod.__setStalledInstallTimeoutForTests(5_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");

      vi.advanceTimersByTime(900);
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      vi.advanceTimersByTime(150);

      expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
        kind: "manual",
        version: undefined,
      });
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

  it("does not install on quit after an error unstuck the flag mid-install", async () => {
    // INSPECTOR-ELECTRON-WF, the exact path four users hit on 3.7.2.
    //
    // `isQuittingForUpdate` is about the CURRENT attempt, so the error handler
    // has to clear it to give the user an answer. But `retireAfterUpdaterError`
    // only rewrites a `pending` status, so the status stays `downloaded` — and
    // both conditions `installUpdateOnQuit` checks are true again while
    // Electron still holds the observer the first `quitAndInstall` registered.
    // Quitting then called it a second time: "Observers can only be added
    // once!" through DumpWithoutCrashing.
    const window = createWindow();
    windows.push(window);
    const { installUpdateOnQuit, registerUpdateListeners } =
      await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);

    // A plain updater error — NOT the refused-by-Electron shape, which has its
    // own relaunch recovery. This one only unsticks the flag.
    emitAutoUpdaterEvent("error", new Error("network died mid-install"));

    // The precondition that made this reachable: the status never moved.
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toMatchObject({ kind: "downloaded" });

    // The user quits. No second call, and the quit is NOT held — returning
    // true here would `preventDefault()` a quit that nothing will finish.
    expect(installUpdateOnQuit()).toBe(false);
    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("hands over the manual download when a click follows a spent install", async () => {
    // Same setup, through the button instead of the quit. Refusing silently
    // would rebuild the dead-button bug this file is full of fixes for, so the
    // refusal has to land somewhere the user can actually act.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("error", new Error("network died mid-install"));

    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toMatchObject({ kind: "manual", version: "3.8.1" });
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
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

  it("hands over the manual download when quitAndInstall never quits the app", async () => {
    // The reported bug at its purest: the build really was downloaded, the
    // click really reached Squirrel, and then nothing came back. No throw, no
    // `error` event, no quit — so `isQuittingForUpdate` stayed true, every
    // later click was swallowed as "already underway", and the renderer sat
    // on "Updating…" for the life of the process.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

      expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
      // Still inside the window: we assume the app is on its way out.
      expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");

      vi.advanceTimersByTime(1_000);

      expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
        kind: "manual",
        version: "2.5.0",
      });
      expect(window.webContents.send).toHaveBeenCalledWith("update-error");

      // And the pill now opens the releases page instead of re-entering the
      // install that just proved it goes nowhere.
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands over the manual download when a queued install never quits the app", async () => {
    // Same silent hang, reached the other way: the user clicked while the
    // download was still running, so `update-downloaded` fired the install.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");

      expect(quitAndInstallMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);

      expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
        kind: "manual",
        version: "2.5.0",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when an updater error already answered the user", async () => {
    // A real `error` is an answer: it clears the quitting flag and toasts on
    // its own. The watchdog must not fire behind it and broadcast a second
    // time.
    vi.useFakeTimers();
    try {
      const window = createWindow();
      windows.push(window);
      const mod = await loadUpdateListeners();
      mod.__setStalledQuitTimeoutForTests(1_000);

      mod.registerUpdateListeners(window as any);
      emitAutoUpdaterEvent("update-available");
      emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "2.5.0");
      ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
      // Squirrel answers with a real error instead of quitting.
      emitAutoUpdaterEvent("error", new Error("squirrel: install failed"));
      (window.webContents.send as any).mockClear();

      vi.advanceTimersByTime(1_000);

      // The error already answered the user; the watchdog must stay quiet
      // rather than broadcasting a second time.
      expect(window.webContents.send).not.toHaveBeenCalledWith("update-error");
    } finally {
      vi.useRealTimers();
    }
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

describe("update polling", () => {
  // Auto-updates only exist on macOS and Windows, and CI runs Linux — without
  // pinning this the whole describe passes by doing nothing.
  const realPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, "platform", {
      value,
      configurable: true,
    });
  };

  beforeEach(() => {
    setPlatform("darwin");
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  beforeEach(() => {
    appState.isPackaged = true;
    autoUpdaterHandlers.clear();
    ipcHandlers.clear();
    ipcListeners.clear();
    windows.splice(0, windows.length);
    checkForUpdatesMock.mockReset();
    quitAndInstallMock.mockReset();
    relaunchMock.mockReset();
    quitMock.mockReset();
    setFeedURLMock.mockReset();
    logErrorMock.mockReset();
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    writeFileSyncMock.mockClear();
    readFileSyncMock.mockClear();
    rmSyncMock.mockClear();
    fsState.files.clear();
  });

  afterEach(() => {
    lastLoadedModule?.__resetUpdateStateForTests();
    lastLoadedModule = null;
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops polling once a build is staged", async () => {
    // THE BUG. update-electron-app polls forever. The poll that lands after a
    // download answers `update-not-available` — correctly, nothing IS newer —
    // and Electron clears g_update_available on that answer, so from then on
    // quitAndInstall() only emits "No update available, can't quit and
    // install". Sophie clicked Update 6 times against exactly that state.
    const { startUpdatePolling } = await loadUpdateListeners();

    startUpdatePolling();
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");

    vi.advanceTimersByTime(30 * 60_000);

    // Still one: the three polls that would have fired were all skipped.
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while no build is staged", async () => {
    const { startUpdatePolling } = await loadUpdateListeners();

    startUpdatePolling();
    vi.advanceTimersByTime(20 * 60_000);

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(3);
  });

  it("asks the update service for the same feed as before", async () => {
    // update-electron-app built this URL; the service matches assets on it,
    // so a change here silently stops every update.
    const { startUpdatePolling } = await loadUpdateListeners();

    startUpdatePolling();

    expect(setFeedURLMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://update.electronjs.org/MCPJam/inspector/darwin-${process.arch}/3.8.0`,
        serverType: "default",
      }),
    );
  });

  it("does not poll on a platform without auto-updates", async () => {
    setPlatform("linux");
    const { startUpdatePolling } = await loadUpdateListeners();

    startUpdatePolling();
    vi.advanceTimersByTime(20 * 60_000);

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(setFeedURLMock).not.toHaveBeenCalled();
  });

  it("does not poll in development", async () => {
    appState.isPackaged = false;
    const { startUpdatePolling } = await loadUpdateListeners();

    startUpdatePolling();
    vi.advanceTimersByTime(20 * 60_000);

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(setFeedURLMock).not.toHaveBeenCalled();
  });
});

describe("install refused by Electron", () => {
  beforeEach(() => {
    appState.isPackaged = true;
    autoUpdaterHandlers.clear();
    ipcHandlers.clear();
    ipcListeners.clear();
    windows.splice(0, windows.length);
    checkForUpdatesMock.mockReset();
    quitAndInstallMock.mockReset();
    relaunchMock.mockReset();
    quitMock.mockReset();
    setFeedURLMock.mockReset();
    logErrorMock.mockReset();
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    writeFileSyncMock.mockClear();
    readFileSyncMock.mockClear();
    rmSyncMock.mockClear();
    fsState.files.clear();
  });

  afterEach(() => {
    lastLoadedModule?.__resetUpdateStateForTests();
    lastLoadedModule = null;
  });

  const MARKER = "/tmp/userData/.install-update-on-relaunch";
  const refusedError = () =>
    new Error("No update available, can't quit and install");

  it("relaunches to re-download when a click is refused", async () => {
    // Sophie's state: a staged build on disk that Electron will not install.
    // Clicking again can only produce the same error, so the button has to
    // stop being the answer — a fresh process is.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });

    emitAutoUpdaterEvent("error", refusedError());

    expect(fsState.files.has(MARKER)).toBe(true);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(quitMock).toHaveBeenCalledTimes(1);
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "idle" });
  });

  it("finishes the install by itself on the next launch", async () => {
    // The other half of the relaunch: the user clicked once, in the previous
    // process. They should not have to click again.
    fsState.files.set(MARKER, JSON.stringify({ at: Date.now() }));
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    // The marker is consumed at setup, so the app never installs twice.
    expect(fsState.files.has(MARKER)).toBe(false);

    emitAutoUpdaterEvent("update-available");
    expect(window.webContents.send).toHaveBeenCalledWith("update-status", {
      kind: "pending",
      installRequested: true,
    });

    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("disarms the hands-free install when the retry finds nothing", async () => {
    // The relaunch is for ONE install. If that check comes back empty the
    // recovery is over, and a release that shows up later must not install
    // itself and take the app down with no click behind it.
    fsState.files.set(MARKER, JSON.stringify({ at: Date.now(), attempts: 1 }));
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-not-available");

    // Much later, an unrelated release lands on its own.
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.9.0");

    expect(quitAndInstallMock).not.toHaveBeenCalled();
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual(
      expect.objectContaining({ kind: "downloaded", version: "3.9.0" }),
    );
  });

  it("disarms the hands-free install after an updater error", async () => {
    fsState.files.set(MARKER, JSON.stringify({ at: Date.now(), attempts: 1 }));
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("error", new Error("network is offline"));

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.9.0");

    expect(quitAndInstallMock).not.toHaveBeenCalled();
  });

  it("keeps the hands-free install when a concurrent check is refused", async () => {
    // That error is about the POLL that collided, not the download it
    // collided with — which is still running and can still land.
    fsState.files.set(MARKER, JSON.stringify({ at: Date.now(), attempts: 1 }));
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent(
      "error",
      Object.assign(new Error("refused"), { domain: "RACCommandErrorDomain" }),
    );
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a marker left over from an older session", async () => {
    fsState.files.set(MARKER, JSON.stringify({ at: Date.now() - 60 * 60_000 }));
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");

    // No click, no relaunch behind us: the button waits for the user.
    expect(quitAndInstallMock).not.toHaveBeenCalled();
  });

  it("stops relaunching if the fresh process cannot install either", async () => {
    // The relaunch is a recovery, not a habit. If it did not work once it
    // will not work twice, and an app that keeps restarting itself is worse
    // than the dead button it was trying to fix.
    fsState.files.set(MARKER, JSON.stringify({ at: Date.now(), attempts: 1 }));
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    emitAutoUpdaterEvent("error", refusedError());

    expect(relaunchMock).not.toHaveBeenCalled();
    expect(fsState.files.has(MARKER)).toBe(false);
    // The releases page is the one path left that always works.
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "manual", version: "3.8.1" });
    expect(window.webContents.send).toHaveBeenCalledWith("update-error");
  });

  it("counts the relaunch it is about to make", async () => {
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("error", refusedError());

    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fsState.files.get(MARKER) as string).attempts).toBe(1);
  });

  it("does not relaunch when the retry cannot be recorded", async () => {
    // A relaunch whose attempt count never reaches disk is the unbounded loop
    // wearing a disguise: every fresh process would start the budget over.
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system");
    });
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("error", refusedError());

    expect(relaunchMock).not.toHaveBeenCalled();
    expect(quitMock).not.toHaveBeenCalled();
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "manual", version: "3.8.1" });
  });

  it("spends the budget on a marker it cannot read back", async () => {
    // Corrupt or unreadable, the file still says a relaunch happened. Reading
    // it as "no attempts yet" would hand back an unlimited restart budget.
    fsState.files.set(MARKER, "{ this is not json");
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    // Not resumed: we never confirmed the user asked for this install.
    expect(quitAndInstallMock).not.toHaveBeenCalled();

    // …but the attempt was counted, so a refusal now goes manual, not around
    // the loop again.
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("error", refusedError());
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(
      ipcHandlers.get("app:get-update-status")?.({ sender: { id: 1 } }),
    ).toEqual({ kind: "manual", version: "3.8.1" });
  });

  it("treats a missing marker as a clean start", async () => {
    // ENOENT is every ordinary launch, and must leave the full budget.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners } = await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");
    ipcListeners.get("app:restart-for-update")?.({ sender: { id: 1 } });
    emitAutoUpdaterEvent("error", refusedError());

    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the user quit when the install is refused at quit", async () => {
    // Sophie hit Cmd+Q three times and the app refused every time:
    // installUpdateOnQuit() returns true, before-quit preventDefault()s, and
    // the install then fails asynchronously with nothing to undo the block.
    // She deleted the app. Quitting must always win.
    const window = createWindow();
    windows.push(window);
    const { registerUpdateListeners, installUpdateOnQuit } =
      await loadUpdateListeners();

    registerUpdateListeners(window as any);
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded", {}, "Notes", "3.8.1");

    expect(installUpdateOnQuit()).toBe(true);
    emitAutoUpdaterEvent("error", refusedError());

    // The quit the user asked for is completed here, not relaunched.
    expect(quitMock).toHaveBeenCalledTimes(1);
    expect(relaunchMock).not.toHaveBeenCalled();
    // And a second before-quit falls straight through instead of blocking.
    expect(installUpdateOnQuit()).toBe(false);
  });
});
