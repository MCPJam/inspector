import { ipcMain, BrowserWindow } from "electron";

export function registerWindowListeners(mainWindow: BrowserWindow): void {
  // Window minimize
  ipcMain.on("window:minimize", () => {
    mainWindow.minimize();
  });

  // Window maximize/restore
  ipcMain.on("window:maximize", () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  // Window close
  ipcMain.on("window:close", () => {
    mainWindow.close();
  });

  // Check if maximized
  ipcMain.handle("window:is-maximized", () => {
    return mainWindow.isMaximized();
  });
}
