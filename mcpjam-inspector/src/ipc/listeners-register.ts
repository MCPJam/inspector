import { BrowserWindow } from "electron";
import { registerAppListeners } from "./app/app-listeners.js";
import { registerWindowListeners } from "./window/window-listeners.js";
import { registerFileListeners } from "./files/file-listeners.js";

export function registerListeners(mainWindow: BrowserWindow): void {
  registerAppListeners(mainWindow);
  registerWindowListeners(mainWindow);
  registerFileListeners(mainWindow);
}
