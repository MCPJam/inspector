import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getVersionMock,
  ipcHandleMock,
  logInfoMock,
  logWarnMock,
  openExternalMock,
  registeredHandlers,
} = vi.hoisted(() => {
  const registeredHandlers = new Map<string, any>();

  return {
    getVersionMock: vi.fn(() => "2.2.0"),
    ipcHandleMock: vi.fn((channel: string, handler: any) => {
      registeredHandlers.set(channel, handler);
    }),
    logInfoMock: vi.fn(),
    logWarnMock: vi.fn(),
    openExternalMock: vi.fn(),
    registeredHandlers,
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: getVersionMock,
  },
  ipcMain: {
    handle: ipcHandleMock,
  },
  shell: {
    openExternal: openExternalMock,
  },
}));

vi.mock("electron-log", () => ({
  default: {
    info: logInfoMock,
    warn: logWarnMock,
  },
}));

import { registerAppListeners } from "../../src/ipc/app/app-listeners.js";

function createWindow(id: number) {
  return {
    webContents: {
      id,
    },
  };
}

function getOpenExternalHandler() {
  const handler = registeredHandlers.get("app:open-external");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("registerAppListeners", () => {
  let currentMainWindow: ReturnType<typeof createWindow> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    currentMainWindow = createWindow(1);

    registerAppListeners(() => currentMainWindow as any);
  });

  it("accepts open-external requests from the current main window", async () => {
    const openExternal = getOpenExternalHandler();

    await expect(
      openExternal({ sender: { id: 1 } }, "https://example.com/oauth"),
    ).resolves.toBeUndefined();

    expect(openExternalMock).toHaveBeenCalledWith("https://example.com/oauth");
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("trusts the replacement window after the main window changes", async () => {
    const openExternal = getOpenExternalHandler();

    currentMainWindow = createWindow(2);

    await expect(
      openExternal({ sender: { id: 2 } }, "https://example.com/oauth"),
    ).resolves.toBeUndefined();

    expect(openExternalMock).toHaveBeenCalledWith("https://example.com/oauth");
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("rejects stale senders after the trusted window changes", async () => {
    const openExternal = getOpenExternalHandler();

    currentMainWindow = createWindow(2);

    await expect(
      openExternal({ sender: { id: 1 } }, "https://example.com/oauth"),
    ).rejects.toThrow("Refusing external open from untrusted renderer");

    expect(openExternalMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledWith(
      "Ignoring open-external from untrusted sender (id: 1)",
    );
  });
});
