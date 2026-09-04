import type { BrowserWindow } from "electron";
import { registerAppListeners } from "./app/app-listeners.js";
import { registerWindowListeners } from "./window/window-listeners.js";
import { registerFileListeners } from "./files/file-listeners.js";
import { registerUpdateListeners } from "./update/update-listeners.js";
import { registerLocalHarnessListeners } from "./local-harness/local-harness-listeners.js";

export function registerListeners(
  mainWindow: BrowserWindow,
  getMainWindow: () => BrowserWindow | null = () => mainWindow,
  /**
   * How the local-harness picker reaches the Inspector server it registers a
   * workspace grant with. Supplied by `main.ts`, which is the only place that
   * knows the bound port and the session token — and both change across a
   * server restart, so they are read at call time rather than captured.
   */
  localHarness?: {
    getServerOrigin: () => string | null;
    getSessionToken: () => string | null;
  },
): void {
  registerAppListeners(getMainWindow);
  registerWindowListeners(mainWindow);
  registerFileListeners(mainWindow);
  registerUpdateListeners(mainWindow);
  if (localHarness) {
    registerLocalHarnessListeners(
      getMainWindow,
      localHarness.getServerOrigin,
      localHarness.getSessionToken,
    );
  }
}
