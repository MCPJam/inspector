import { ipcMain, type BrowserWindow } from "electron";
import * as Sentry from "@sentry/electron/main";
import {
  getDesktopSentryIdentity,
  setDesktopSentryActor,
} from "../shared/desktop-sentry-state.js";
import {
  parseSentryActor,
  SENTRY_ACTOR_CHANNEL,
} from "../shared/sentry-identity.js";

export function installDesktopSentryIdentity() {
  let trusted: BrowserWindow | undefined;
  let origin: string | undefined;
  const reset = () => publish(null);
  function publish(actor: Parameters<typeof setDesktopSentryActor>[0]) {
    const identity = setDesktopSentryActor(actor);
    Sentry.setUser(identity ? { id: identity.id } : null);
    Sentry.setTag("actor_kind", identity?.kind);
  }
  ipcMain.on(SENTRY_ACTOR_CHANNEL, (event, value: unknown) => {
    try {
      if (
        !trusted ||
        trusted.isDestroyed() ||
        event.sender !== trusted.webContents ||
        event.senderFrame !== trusted.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== origin
      )
        return;
      const actor = parseSentryActor(value);
      if (actor !== undefined) publish(actor);
    } catch {
      /* Malformed messages and destroyed frames are ignored. */
    }
  });
  return {
    bind(window: BrowserWindow, url: string) {
      trusted = window;
      origin = new URL(url).origin;
      reset();
      window.webContents.on(
        "did-start-navigation",
        (_event, _url, inPlace, isMainFrame) => {
          if (trusted === window && isMainFrame && !inPlace) reset();
        },
      );
      window.on("closed", () => {
        if (trusted === window) {
          trusted = undefined;
          reset();
        }
      });
    },
    getIdentity: getDesktopSentryIdentity,
  };
}
