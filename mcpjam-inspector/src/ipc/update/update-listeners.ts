import { ipcMain, BrowserWindow, autoUpdater } from "electron";
import log from "electron-log";

const isDev = process.env.NODE_ENV === "development";

export function registerUpdateListeners(mainWindow: BrowserWindow): void {
  // Handle restart request from renderer
  ipcMain.on("app:restart-for-update", (event) => {
    if (event.sender.id !== mainWindow.webContents.id) {
      log.warn(
        `Ignoring restart-for-update from untrusted sender (id: ${event.sender.id})`,
      );
      return;
    }
    log.info("Restarting app to install update...");
    autoUpdater.quitAndInstall();
  });

  // Dev only: simulate update for testing UI
  if (isDev) {
    ipcMain.on("app:simulate-update", (event) => {
      if (event.sender.id !== mainWindow.webContents.id) {
        log.warn(
          `Ignoring simulate-update from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }
      log.info("Simulating update available (dev mode)");
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("update-ready", {
          version: "99.0.0",
          releaseNotes: "Simulated update for testing",
        });
      }
    });
  }
}

export function setupAutoUpdaterEvents(mainWindow: BrowserWindow): void {
  // Listen for update-downloaded event from autoUpdater
  autoUpdater.on("update-downloaded", (event, releaseNotes, releaseName) => {
    log.info(`Update downloaded: ${releaseName}`);

    // Notify renderer that update is ready
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-ready", {
        version: releaseName || "new version",
        releaseNotes: releaseNotes || "",
      });
    }
  });

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", () => {
    log.info("Update available, downloading...");
  });

  autoUpdater.on("update-not-available", () => {
    log.info("No updates available");
  });

  autoUpdater.on("error", (error) => {
    log.error("Auto-updater error:", error);
  });
}
