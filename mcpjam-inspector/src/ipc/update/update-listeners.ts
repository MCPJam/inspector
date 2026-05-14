import { ipcMain, BrowserWindow, autoUpdater, app } from "electron";
import log from "electron-log";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "pending"; version?: string; installRequested: boolean }
  | { kind: "downloaded"; version: string; releaseNotes?: string };

let currentStatus: UpdateStatus = { kind: "idle" };
let isQuittingForUpdate = false;
let isCheckingOrDownloading = false;
let trustedWindow: BrowserWindow | null = null;
let updateListenersRegistered = false;

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
      setStatus({ ...currentStatus, installRequested: false });
    }
    log.info(
      `Keeping visible update status after update-not-available: ${currentStatus.kind}`,
    );
  });

  autoUpdater.on("error", (error) => {
    isCheckingOrDownloading = false;
    log.error("Auto-updater error:", error);
    const shouldNotifyUser =
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
      autoUpdater.quitAndInstall();
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
      autoUpdater.quitAndInstall();
    } else if (currentStatus.kind === "pending") {
      log.info("Update still downloading — queuing install for completion");
      setStatus({ ...currentStatus, installRequested: true });
      if (!isCheckingOrDownloading) {
        try {
          isCheckingOrDownloading = true;
          autoUpdater.checkForUpdates();
        } catch (error) {
          isCheckingOrDownloading = false;
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
  currentStatus = { kind: "idle" };
  isQuittingForUpdate = false;
  isCheckingOrDownloading = false;
  trustedWindow = null;
  updateListenersRegistered = false;
}
