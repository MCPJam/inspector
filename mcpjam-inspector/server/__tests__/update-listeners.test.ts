import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  version: "3.10.0",
  packaged: true,
  handlers: new Map<string, (...args: any[]) => void>(),
  ipc: new Map<string, (...args: any[]) => any>(),
  files: new Map<string, string>(),
  write: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  install: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  check: vi.fn(),
  feed: vi.fn(),
  capture: vi.fn(),
  flush: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("node:fs", () => ({
  default: {
    readFileSync: (file: string) => {
      if (!mocks.files.has(file))
        throw Object.assign(new Error(), { code: "ENOENT" });
      return mocks.files.get(file);
    },
    writeFileSync: (...args: any[]) => mocks.write(...args),
    renameSync: (...args: any[]) => mocks.rename(...args),
    rmSync: (...args: any[]) => mocks.remove(...args),
  },
}));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    getVersion: () => mocks.version,
    getPath: () => "/tmp/userData",
    relaunch: mocks.relaunch,
    quit: mocks.quit,
  },
  autoUpdater: {
    on: (name: string, handler: (...args: any[]) => void) =>
      mocks.handlers.set(name, handler),
    quitAndInstall: mocks.install,
    checkForUpdates: mocks.check,
    setFeedURL: mocks.feed,
  },
  ipcMain: {
    on: (name: string, handler: (...args: any[]) => void) =>
      mocks.ipc.set(name, handler),
    handle: (name: string, handler: (...args: any[]) => void) =>
      mocks.ipc.set(name, handler),
  },
}));
vi.mock("electron-log", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: mocks.warn },
}));
vi.mock("@sentry/electron/main", () => ({
  captureEvent: mocks.capture,
  flush: mocks.flush,
  withScope: (callback: (scope: any) => void) =>
    callback({ addEventProcessor: vi.fn() }),
}));

const realPlatform = process.platform;
const file = "/tmp/userData/.install-update-on-relaunch";
const event = { sender: { id: 1 } };
let mod: typeof import("../../src/ipc/update/update-listeners.js");
let window: ReturnType<typeof createWindow>;
function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 1,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => false),
      once: vi.fn(),
    },
  };
}
function emit(name: string, ...args: any[]) {
  mocks.handlers.get(name)?.(...args);
}
function click() {
  mocks.ipc.get("app:restart-for-update")?.(event);
}
function status() {
  return mocks.ipc.get("app:get-update-status")?.(event);
}
function marker() {
  return JSON.parse(mocks.files.get(file)!);
}
function downloaded() {
  emit("update-available");
  emit("update-downloaded", {}, "Notes", "Release v3.11.0");
}
async function boot() {
  mod?.__resetUpdateStateForTests();
  mocks.handlers.clear();
  mocks.ipc.clear();
  vi.resetModules();
  mod = await import("../../src/ipc/update/update-listeners.js");
  mod.setupAutoUpdaterEvents();
  window = createWindow();
  mod.registerUpdateListeners(window as any);
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.packaged = true;
  mocks.version = "3.10.0";
  for (const fn of [
    mocks.install,
    mocks.quit,
    mocks.relaunch,
    mocks.check,
    mocks.feed,
    mocks.capture,
  ])
    fn.mockReset();
  mocks.flush.mockReset().mockResolvedValue(true);
  mocks.write
    .mockReset()
    .mockImplementation((file, data) => mocks.files.set(file, data));
  mocks.rename.mockReset().mockImplementation((from, to) => {
    mocks.files.set(to, mocks.files.get(from)!);
    mocks.files.delete(from);
  });
  mocks.remove
    .mockReset()
    .mockImplementation((file) => mocks.files.delete(file));
  await boot();
});
afterEach(() => {
  mod.__resetUpdateStateForTests();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: realPlatform });
});

describe("update recovery", () => {
  it("restarts once after a refused install, downloads again, and verifies the installed version", async () => {
    downloaded();
    click();
    emit("error", new Error("No update available, can't quit and install"));
    expect(status().kind).toBe("recovering");
    expect(marker()).toMatchObject({
      phase: "recovering",
      retries: 1,
      fromVersion: "3.10.0",
      targetVersion: "3.11.0",
      userRequested: true,
    });
    const id = marker().id;
    await settle();
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
    await boot();
    expect(status()).toMatchObject({ kind: "pending", installRequested: true });
    mod.startUpdatePolling();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    downloaded();
    expect(mocks.install).toHaveBeenCalledTimes(2); // once in each process
    expect(marker()).toMatchObject({ id, phase: "installing", retries: 1 });
    mocks.version = "3.11.0";
    await boot();
    expect(status()).toEqual({ kind: "idle" });
    expect(mocks.files.has(file)).toBe(false);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not loop if the recovered install fails", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    await boot();
    downloaded();
    emit("error", new Error("failure"));
    await settle();
    expect(status()).toMatchObject({ kind: "failed", reason: "updater_error" });
    expect(marker()).toMatchObject({ phase: "failed", retries: 1 });
    click();
    emit("update-available");
    downloaded();
    emit("error", new Error("again"));
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it("reports an unchanged version after installation, then spends the one recovery", async () => {
    downloaded();
    click();
    await boot();
    await settle();
    expect(status().kind).toBe("recovering");
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.objectContaining({ update_reason: "version_unchanged" }),
      }),
    );
    await boot();
    downloaded();
    await boot();
    expect(status()).toMatchObject({
      kind: "failed",
      reason: "version_unchanged",
    });
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not call the native installer twice after duplicate clicks or a throw", async () => {
    downloaded();
    mocks.install.mockImplementation(() => {
      throw new Error("failure");
    });
    click();
    click();
    mod.installUpdateOnQuit();
    await settle();
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not restart on background download failure", async () => {
    emit("update-available");
    emit("error", new Error("offline"));
    await settle();
    expect(status()).toMatchObject({ kind: "failed", reason: "updater_error" });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("retains the full download deadline after an Update click", async () => {
    emit("update-available");
    await vi.advanceTimersByTimeAsync(60_000);
    click();
    click();
    await vi.advanceTimersByTimeAsync(19 * 60_000 - 1);
    expect(status()).toMatchObject({ kind: "pending", installRequested: true });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("installs a slow download normally", async () => {
    emit("update-available");
    click();
    await vi.advanceTimersByTimeAsync(90_000);
    emit("update-downloaded", {}, "", "3.11.0");
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("times out downloads even if nobody clicks", async () => {
    emit("update-available");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(status()).toMatchObject({
      kind: "failed",
      reason: "download_timeout",
    });
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("does not extend the download deadline when availability is repeated", async () => {
    emit("update-available");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    emit("update-available");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(status().reason).toBe("download_timeout");
  });

  it("ignores overlapping native checks without retiring a download", () => {
    emit("update-available");
    emit(
      "error",
      Object.assign(new Error("busy"), { domain: "RACCommandErrorDomain" }),
    );
    emit("error", new Error("AutoUpdater process 123 is already running"));
    expect(status().kind).toBe("pending");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("recovers when an install returns without quitting", async () => {
    downloaded();
    click();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(status().kind).toBe("recovering");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status()).toMatchObject({
      kind: "failed",
      reason: "shutdown_stuck",
    });
  });

  it("recommends force quit when the recovered native install still does not quit", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    await boot();
    downloaded();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status().reason).toBe("shutdown_stuck");
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("keeps a stuck shutdown error available after renderer reload", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    const failure = status();
    const replacement = createWindow();
    replacement.webContents.id = 2;
    mod.setTrustedUpdateWindow(replacement as any);
    expect(replacement.webContents.send).toHaveBeenCalledWith(
      "update-status",
      failure,
    );
    expect(failure.reason).toBe("shutdown_stuck");
    expect(mocks.ipc.get("app:get-update-status")?.(event)).toEqual({
      kind: "idle",
    });
  });

  it("bounds reporting flush before restarting", async () => {
    mocks.flush.mockImplementation(() => new Promise(() => {}));
    downloaded();
    click();
    emit("error", new Error("failure"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("restarts even when reporting throws or flush rejects", async () => {
    mocks.capture.mockImplementation(() => {
      throw new Error("offline");
    });
    mocks.flush.mockRejectedValue(new Error("offline"));
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not restart when the retry marker cannot be saved", async () => {
    downloaded();
    click();
    mocks.rename.mockImplementation(() => {
      throw new Error("read-only");
    });
    emit("error", new Error("failure"));
    await settle();
    expect(status().reason).toBe("marker_write_failed");
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("does not enter the native installer when its attempt cannot be saved", () => {
    downloaded();
    mocks.write.mockImplementation(() => {
      throw new Error("full");
    });
    click();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(status().reason).toBe("marker_write_failed");
  });

  it("handles relaunch exceptions without another restart", async () => {
    mocks.relaunch.mockImplementation(() => {
      throw new Error("failure");
    });
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    expect(status().reason).toBe("restart_failed");
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("finishes a normal quit instead of turning it into recovery", async () => {
    downloaded();
    expect(mod.installUpdateOnQuit()).toBe(true);
    emit("error", new Error("No update available, can't quit and install"));
    await settle();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.quit).toHaveBeenCalledTimes(1);
    expect(mod.installUpdateOnQuit()).toBe(false);
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm a watchdog after a synchronous native error", async () => {
    downloaded();
    mocks.install.mockImplementation(() => emit("error", new Error("failure")));
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status().reason).toBe("shutdown_stuck");
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("checks again without unattended installation after reopening a failed attempt", async () => {
    emit("update-available");
    emit("error", new Error("offline"));
    await boot();
    const failure = status();
    expect(failure.kind).toBe("failed");
    const reports = mocks.capture.mock.calls.length;
    mod.startUpdatePolling();
    emit("error", new Error("offline again"));
    expect(status()).toEqual(failure);
    expect(mocks.capture).toHaveBeenCalledTimes(reports);
    expect(mocks.files.has(file)).toBe(false);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    downloaded();
    expect(status().kind).toBe("downloaded");
    expect(mocks.install).not.toHaveBeenCalled();
    click();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("fails a recovery that finds no update and disarms late downloads", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    await boot();
    emit("update-not-available");
    downloaded();
    expect(status().reason).toBe("no_update");
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("times out a recovery whose initial check never answers", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    await boot();
    mod.startUpdatePolling();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(status().reason).toBe("download_timeout");
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("polling and IPC", () => {
  it("skips platforms without native auto-update", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mod.startUpdatePolling();
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("uses the Windows feed on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mod.startUpdatePolling();
    expect(mocks.feed).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://update.electronjs.org/MCPJam/inspector/win32-${process.arch}/3.10.0`,
      }),
    );
  });

  it("stops checking once a build is staged", async () => {
    mod.startUpdatePolling();
    downloaded();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(status().kind).toBe("downloaded");
  });
  it("continues checking when there is no update", async () => {
    mod.startUpdatePolling();
    emit("update-not-available");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });
  it("does not run overlapping download checks", async () => {
    mod.startUpdatePolling();
    emit("update-available");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it.each(["event", "throw"])(
    "only warns for an idle check failure: %s",
    async (source) => {
      mocks.check.mockImplementation(() => {
        if (source === "throw") throw new Error("offline");
        emit("error", new Error("offline"));
      });
      mod.startUpdatePolling();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(status().kind).toBe("idle");
      expect(mocks.check).toHaveBeenCalledTimes(2);
      expect(mocks.warn).toHaveBeenCalledTimes(2);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.files.has(file)).toBe(false);
      expect(mocks.relaunch).not.toHaveBeenCalled();
      expect(mocks.quit).not.toHaveBeenCalled();
    },
  );
  it("still fails a recovery when its check throws", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    await boot();
    mocks.capture.mockClear();
    mocks.check.mockImplementation(() => {
      throw new Error("offline");
    });
    mod.startUpdatePolling();
    expect(status()).toMatchObject({ kind: "failed", reason: "updater_error" });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });
  it("captures feed setup failures", () => {
    mocks.feed.mockImplementation(() => {
      throw new Error("failure");
    });
    mod.startUpdatePolling();
    expect(status().reason).toBe("updater_error");
  });
  it("ignores untrusted and destroyed senders", () => {
    downloaded();
    mocks.ipc.get("app:restart-for-update")?.({ sender: { id: 99 } });
    window.isDestroyed.mockReturnValue(true);
    click();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("registers IPC only once and snapshots status after the window loads", () => {
    downloaded();
    window.webContents.isLoading.mockReturnValue(true);
    mod.registerUpdateListeners(window as any);
    const listener = window.webContents.once.mock.calls[0][1] as () => void;
    listener();
    expect(window.webContents.send).toHaveBeenCalledWith(
      "update-status",
      expect.objectContaining({ kind: "downloaded" }),
    );
  });
  it("does not poll or quit in development, including simulated errors", async () => {
    mocks.packaged = false;
    await boot();
    mod.startUpdatePolling();
    mocks.ipc.get("app:simulate-update")?.(event);
    click();
    mocks.ipc.get("app:simulate-update-error")?.(event);
    expect(status().kind).toBe("failed");
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mod.installUpdateOnQuit()).toBe(false);
  });
});

describe("persisted attempts", () => {
  it.each(["not json", "null", '{"at":1,"attempts":1}'])(
    "never auto-resumes an invalid or legacy marker: %s",
    async (raw) => {
      mocks.files.set(file, raw);
      await boot();
      expect(status().reason).toBe("marker_invalid");
      expect(mocks.relaunch).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
    },
  );
  it("preserves an expired failed marker without reporting another failure", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status().reason).toBe("shutdown_stuck");
    const failure = status();
    const data = marker();
    data.at -= 16 * 60_000;
    mocks.files.set(file, JSON.stringify(data));
    mocks.capture.mockClear();
    await boot();
    expect(status()).toEqual(failure);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.files.has(file)).toBe(false);
  });
  it("does not auto-resume an expired recovery", async () => {
    downloaded();
    click();
    emit("error", new Error("failure"));
    await settle();
    const data = marker();
    data.at -= 16 * 60_000;
    mocks.files.set(file, JSON.stringify(data));
    await boot();
    expect(status().reason).toBe("recovery_expired");
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });
  it("verifies a successful install even when the next launch is days later", async () => {
    downloaded();
    click();
    const data = marker();
    data.at -= 7 * 24 * 60 * 60_000;
    mocks.files.set(file, JSON.stringify(data));
    mocks.version = "3.11.0";
    await boot();
    expect(status().kind).toBe("idle");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not restart again when startup cannot remove a completed marker", async () => {
    downloaded();
    click();
    mocks.version = "3.11.0";
    mocks.remove.mockImplementation(() => {
      throw new Error("read-only");
    });
    await boot();
    expect(status().reason).toBe("marker_write_failed");
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("accepts a manually installed newer version", async () => {
    downloaded();
    click();
    mocks.version = "3.12.0";
    await boot();
    expect(status().kind).toBe("idle");
    expect(mocks.files.has(file)).toBe(false);
  });
  it("rejects the wrong installed version", async () => {
    downloaded();
    click();
    mocks.version = "3.10.1";
    await boot();
    await settle();
    expect(status().kind).toBe("recovering");
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.objectContaining({ update_reason: "version_unchanged" }),
      }),
    );
  });
  it("does not send native error strings or arbitrary release names to Sentry", async () => {
    emit(
      "update-downloaded",
      {},
      "secret",
      "https://private/feed?token=secret",
    );
    click();
    emit("error", new Error("/Users/private/token=secret"));
    await settle();
    const captured = JSON.stringify(mocks.capture.mock.calls);
    expect(captured).not.toContain("secret");
    expect(captured).not.toContain("/Users");
  });
});
