import { ipcMain, app, BrowserWindow, shell } from "electron";
import log from "electron-log";

export function registerAppListeners(_mainWindow: BrowserWindow): void {
  // Get app version
  ipcMain.handle("app:version", () => {
    return app.getVersion();
  });

  // Get platform
  ipcMain.handle("app:platform", () => {
    return process.platform;
  });

  ipcMain.handle("app:open-external", async (_event, url: string) => {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Refusing to open invalid external URL");
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Refusing to open non-HTTP external URL");
    }

    log.info("Renderer requested system browser open");
    await shell.openExternal(parsedUrl.toString());
  });
}
