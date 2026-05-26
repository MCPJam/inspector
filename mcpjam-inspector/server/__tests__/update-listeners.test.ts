import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function loadUpdateListeners() {
  vi.resetModules();
  const mod = await import("../../src/ipc/update/update-listeners.js");
  mod.setupAutoUpdaterEvents();
  return mod;
}

describe("update-listeners", () => {
  beforeEach(() => {
    appState.isPackaged = true;
    autoUpdaterHandlers.clear();
    ipcHandlers.clear();
    ipcListeners.clear();
    windows.splice(0, windows.length);
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
});
