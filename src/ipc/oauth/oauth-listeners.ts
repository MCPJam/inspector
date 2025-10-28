import { ipcMain, shell, BrowserWindow } from "electron";
import log from "electron-log";

export function registerOAuthListeners(mainWindow: BrowserWindow): void {
  // Open OAuth URL in external browser
  ipcMain.handle("oauth:openExternal", async (_, url: string) => {
    try {
      log.info("Opening OAuth URL in external browser:", url);
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      log.error("Failed to open OAuth URL in external browser:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });
}
