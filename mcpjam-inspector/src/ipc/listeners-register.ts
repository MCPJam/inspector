import type { BrowserWindow } from "electron";
import { registerAppListeners } from "./app/app-listeners.js";
import { registerWindowListeners } from "./window/window-listeners.js";
import { registerFileListeners } from "./files/file-listeners.js";
import { registerUpdateListeners } from "./update/update-listeners.js";

export function registerListeners(
  mainWindow: BrowserWindow,
  getMainWindow: () => BrowserWindow | null = () => mainWindow,
): void {
  registerAppListeners(getMainWindow);
  registerWindowListeners(mainWindow);
  registerFileListeners(mainWindow);
  registerUpdateListeners(mainWindow);
}
