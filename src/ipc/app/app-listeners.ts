import { ipcMain, app, BrowserWindow } from "electron";

export function registerAppListeners(mainWindow: BrowserWindow): void {
  // Get app version
  ipcMain.handle("app:version", () => {
    return app.getVersion();
  });

  // Get platform
  ipcMain.handle("app:platform", () => {
    return process.platform;
  });
}
