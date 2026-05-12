import { ipcMain, app, shell } from "electron";
import type { BrowserWindow } from "electron";
import log from "electron-log";

export function registerAppListeners(
  getMainWindow: () => BrowserWindow | null,
): void {
  // Get app version
  ipcMain.handle("app:version", () => {
    return app.getVersion();
  });

  // Get platform
  ipcMain.handle("app:platform", () => {
    return process.platform;
  });

  ipcMain.handle("app:open-external", async (event, url: string) => {
    const mainWindow = getMainWindow();

    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      log.warn(
        `Ignoring open-external from untrusted sender (id: ${event.sender.id})`,
      );
      throw new Error("Refusing external open from untrusted renderer");
    }

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
