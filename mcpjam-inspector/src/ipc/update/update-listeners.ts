import { ipcMain, BrowserWindow, autoUpdater, app } from "electron";
import log from "electron-log";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "pending"; version?: string; installRequested: boolean }
  | { kind: "downloaded"; version: string; releaseNotes?: string };

// Watchdog for a stuck `pending + installRequested` state. Squirrel.Mac can
// stall silently (mismatched TeamID, dropped connection) without firing
// `update-downloaded` or `error`. After this timeout we treat the install
// request as failed so the UI unsticks. Exposed as a `let` so tests can
// shorten it via __setStalledInstallTimeoutForTests().
export const DEFAULT_STALLED_INSTALL_TIMEOUT_MS = 60_000;
let stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;

let currentStatus: UpdateStatus = { kind: "idle" };
let isQuittingForUpdate = false;
let isCheckingOrDownloading = false;
let trustedWindow: BrowserWindow | null = null;
let updateListenersRegistered = false;
let stalledInstallTimer: ReturnType<typeof setTimeout> | null = null;

function clearStalledInstallWatchdog(): void {
  if (stalledInstallTimer !== null) {
    clearTimeout(stalledInstallTimer);
    stalledInstallTimer = null;
  }
}

function startStalledInstallWatchdog(): void {
  clearStalledInstallWatchdog();
  stalledInstallTimer = setTimeout(() => {
    stalledInstallTimer = null;
    // Re-check at fire-time: if anything succeeded or moved on, do nothing.
    if (
      currentStatus.kind === "pending" &&
      currentStatus.installRequested
    ) {
      log.error(
        `Auto-updater stalled in pending+installRequested for ${stalledInstallTimeoutMs}ms — surfacing error`,
      );
      isCheckingOrDownloading = false;
      setStatus({ ...currentStatus, installRequested: false });
      broadcastUpdateError();
    }
  }, stalledInstallTimeoutMs);
}

function isTrustedSender(senderId: number): boolean {
  return (
    trustedWindow !== null &&
    !trustedWindow.isDestroyed() &&
    senderId === trustedWindow.webContents.id
  );
}

export function setTrustedUpdateWindow(window: BrowserWindow): void {
  trustedWindow = window;

  if (currentStatus.kind === "idle") {
    return;
  }

  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) {
        window.webContents.send("update-status", currentStatus);
      }
    });
    return;
  }

  window.webContents.send("update-status", currentStatus);
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update-status", currentStatus);
    }
  }
}

function broadcastUpdateError(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update-error");
    }
  }
}

function setStatus(next: UpdateStatus): void {
  currentStatus = next;
  broadcast();
}

export function setupAutoUpdaterEvents(): void {
  autoUpdater.on("checking-for-update", () => {
    isCheckingOrDownloading = true;
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", () => {
    isCheckingOrDownloading = true;
    log.info("Update available, downloading...");
    const installRequested =
      currentStatus.kind === "pending" ? currentStatus.installRequested : false;
    setStatus({ kind: "pending", installRequested });
  });

  autoUpdater.on("update-not-available", () => {
    isCheckingOrDownloading = false;
    log.info("No updates available");
    if (currentStatus.kind === "idle") {
      setStatus({ kind: "idle" });
      return;
    }
    if (currentStatus.kind === "pending" && currentStatus.installRequested) {
      clearStalledInstallWatchdog();
      setStatus({ ...currentStatus, installRequested: false });
    }
    log.info(
      `Keeping visible update status after update-not-available: ${currentStatus.kind}`,
    );
  });

  autoUpdater.on("error", (error) => {
    isCheckingOrDownloading = false;
    clearStalledInstallWatchdog();
    log.error("Auto-updater error:", error);
    // Always notify users in packaged builds — Bug 2: previously we only
    // broadcast when the user had clicked, so download failures before any
    // click silently swallowed the error and the button kept inviting clicks.
    const shouldNotifyUser =
      app.isPackaged ||
      (currentStatus.kind === "pending" && currentStatus.installRequested) ||
      isQuittingForUpdate;

    if (currentStatus.kind === "pending") {
      setStatus({ ...currentStatus, installRequested: false });
    } else if (currentStatus.kind === "downloaded") {
      setStatus(currentStatus);
    } else {
      setStatus({ kind: "idle" });
    }
    isQuittingForUpdate = false;

    if (shouldNotifyUser) {
      broadcastUpdateError();
    }
  });

  autoUpdater.on("update-downloaded", (_event, releaseNotes, releaseName) => {
    isCheckingOrDownloading = false;
    clearStalledInstallWatchdog();
    log.info(`Update downloaded: ${releaseName}`);
    const installRequested =
      currentStatus.kind === "pending" ? currentStatus.installRequested : false;
    setStatus({
      kind: "downloaded",
      version: releaseName || "new version",
      releaseNotes: releaseNotes || "",
    });
    if (installRequested && !isQuittingForUpdate) {
      log.info("User had requested install — restarting now");
      isQuittingForUpdate = true;
      try {
        autoUpdater.quitAndInstall();
      } catch (error) {
        // quitAndInstall can throw on macOS when the staged build is
        // mis-signed or Squirrel's staging dir is corrupted. Don't leave the
        // quitting flag stuck — surface the error so the user can retry.
        log.error("quitAndInstall threw:", error);
        isQuittingForUpdate = false;
        broadcastUpdateError();
      }
    }
  });
}

export function registerUpdateListeners(mainWindow: BrowserWindow): void {
  setTrustedUpdateWindow(mainWindow);

  if (updateListenersRegistered) {
    return;
  }
  updateListenersRegistered = true;

  ipcMain.handle("app:get-update-status", (event) => {
    if (!isTrustedSender(event.sender.id)) {
      log.warn(
        `Ignoring get-update-status from untrusted sender (id: ${event.sender.id})`,
      );
      return { kind: "idle" } satisfies UpdateStatus;
    }
    return currentStatus;
  });

  ipcMain.on("app:restart-for-update", (event) => {
    if (!isTrustedSender(event.sender.id)) {
      log.warn(
        `Ignoring restart-for-update from untrusted sender (id: ${event.sender.id})`,
      );
      return;
    }
    if (currentStatus.kind === "downloaded") {
      log.info("Restarting app to install update...");
      isQuittingForUpdate = true;
      try {
        autoUpdater.quitAndInstall();
      } catch (error) {
        log.error("quitAndInstall threw:", error);
        isQuittingForUpdate = false;
        broadcastUpdateError();
      }
    } else if (currentStatus.kind === "pending") {
      log.info("Update still downloading — queuing install for completion");
      setStatus({ ...currentStatus, installRequested: true });
      // Arm the watchdog — if neither `update-downloaded` nor `error` fires
      // within stalledInstallTimeoutMs, treat as stalled (Bug 1).
      startStalledInstallWatchdog();
      if (!isCheckingOrDownloading) {
        try {
          isCheckingOrDownloading = true;
          autoUpdater.checkForUpdates();
        } catch (error) {
          isCheckingOrDownloading = false;
          clearStalledInstallWatchdog();
          log.error("Failed to retry update check:", error);
          setStatus({ ...currentStatus, installRequested: false });
          broadcastUpdateError();
        }
      }
    } else {
      log.info("Restart requested but no update is staged");
    }
  });

  if (!app.isPackaged) {
    ipcMain.on("app:simulate-update", (event) => {
      if (!isTrustedSender(event.sender.id)) {
        log.warn(
          `Ignoring simulate-update from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }
      log.info("Simulating update available (dev mode)");
      setStatus({ kind: "pending", installRequested: false });
    });

    ipcMain.on("app:simulate-update-downloaded", (event) => {
      if (!isTrustedSender(event.sender.id)) {
        log.warn(
          `Ignoring simulate-update-downloaded from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }
      log.info("Simulating update downloaded (dev mode)");
      const installRequested =
        currentStatus.kind === "pending" && currentStatus.installRequested;
      setStatus({
        kind: "downloaded",
        version: "99.0.0",
        releaseNotes: "Simulated update for testing",
      });
      if (installRequested) {
        log.info("User had requested install — would restart now (dev mode)");
      }
    });

    ipcMain.on("app:simulate-update-error", (event) => {
      if (!isTrustedSender(event.sender.id)) {
        log.warn(
          `Ignoring simulate-update-error from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }
      log.error("Auto-updater error:", new Error("Simulated update failure"));
      clearStalledInstallWatchdog();
      // Dev simulation keeps its tighter notify rule (only the user-driven
      // case) so manual QA can still distinguish click-vs-no-click flows.
      const shouldNotifyUser =
        currentStatus.kind === "pending" && currentStatus.installRequested;
      if (currentStatus.kind === "pending") {
        setStatus({ ...currentStatus, installRequested: false });
      } else if (currentStatus.kind === "downloaded") {
        setStatus(currentStatus);
      } else {
        setStatus({ kind: "idle" });
      }
      if (shouldNotifyUser) {
        broadcastUpdateError();
      }
    });
  }
}

export function installUpdateOnQuit(): boolean {
  if (!app.isPackaged) {
    return false;
  }
  if (currentStatus.kind === "downloaded" && !isQuittingForUpdate) {
    log.info("Staged update found at quit — installing before exit");
    isQuittingForUpdate = true;
    autoUpdater.quitAndInstall();
    return true;
  }
  return false;
}

// Test-only reset
export function __resetUpdateStateForTests(): void {
  clearStalledInstallWatchdog();
  currentStatus = { kind: "idle" };
  isQuittingForUpdate = false;
  isCheckingOrDownloading = false;
  trustedWindow = null;
  updateListenersRegistered = false;
  stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;
}

// Test-only timeout override so the watchdog test doesn't have to advance
// a full minute of fake timers.
export function __setStalledInstallTimeoutForTests(ms: number): void {
  stalledInstallTimeoutMs = ms;
}
