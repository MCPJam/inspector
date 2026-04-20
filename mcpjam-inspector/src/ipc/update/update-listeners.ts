import { ipcMain, BrowserWindow } from "electron";
import log from "electron-log";
import {
  IDLE_UPDATE_STATE,
  type UpdateState,
} from "../../../shared/update-state.js";
import type { UpdateController } from "./update-controller.js";

const isDev = process.env.NODE_ENV === "development";
export const GET_UPDATE_STATE_CHANNEL = "app:update:get-state";
export const REQUEST_UPDATE_INSTALL_CHANNEL = "app:request-update-install";
export const UPDATE_STATE_CHANGED_CHANNEL = "update-state-changed";

export function registerUpdateListeners(
  getMainWindow: () => BrowserWindow | null,
  updateController: UpdateController,
): void {
  ipcMain.handle(GET_UPDATE_STATE_CHANNEL, (event): UpdateState => {
    if (!isTrustedSender(event.sender.id, getMainWindow())) {
      log.warn(
        `Ignoring get-state request from untrusted sender (id: ${event.sender.id})`,
      );
      return { ...IDLE_UPDATE_STATE };
    }

    return updateController.getState();
  });

  ipcMain.on(REQUEST_UPDATE_INSTALL_CHANNEL, (event) => {
    if (!isTrustedSender(event.sender.id, getMainWindow())) {
      log.warn(
        `Ignoring request-update-install from untrusted sender (id: ${event.sender.id})`,
      );
      return;
    }

    updateController.requestInstall();
  });

  if (isDev) {
    ipcMain.on("app:simulate-update", (event) => {
      if (!isTrustedSender(event.sender.id, getMainWindow())) {
        log.warn(
          `Ignoring simulate-update from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }

      log.info("Simulating update ready (dev mode)");
      updateController.simulateReady();
    });
  }
}

function isTrustedSender(
  senderId: number,
  mainWindow: BrowserWindow | null,
): boolean {
  return senderId === mainWindow?.webContents.id;
}
