import { app, ipcMain, type BrowserWindow } from "electron";
import * as Sentry from "@sentry/electron/main";
import { createDesktopDiagnostics } from "./desktop-diagnostics.js";
import { DESKTOP_DIAGNOSTICS_CHANNEL } from "../shared/desktop-diagnostics.js";

export function installDesktopDiagnostics() {
  const collector = createDesktopDiagnostics({
    publish: (snapshot) => {
      Sentry.setContext("desktop_diagnostics", snapshot);
      Sentry.setTag("desktop_run_id", String(snapshot.run_id));
    },
    report: (summary) => {
      if (Sentry.getClient()?.getOptions().enabled === false) return;
      Sentry.withScope((scope) => {
        // Inherited breadcrumbs/identity can contain callback URLs. This event
        // uses only our allowlisted history, never the ambient renderer scope.
        scope.addEventProcessor((event) => ({
          ...event,
          user: undefined,
          request: undefined,
          extra: undefined,
          breadcrumbs: [],
          contexts: {
            desktop_diagnostics: {
              ...summary,
              main_version: app.getVersion(),
              electron_version: process.versions.electron,
            },
          },
          tags: {
            component: "desktop-proxy-diagnostics",
            desktop_run_id: collector.runId,
            deployment: "self_hosted",
          },
        }));
        Sentry.captureEvent({
          event_id: String(summary.observation_event_id),
          message: "Desktop proxy process observation",
          level: "info",
          fingerprint: ["desktop-proxy-observation"],
        });
      });
    },
  });
  Sentry.addEventProcessor((event) => {
    collector.nativeEvent(event);
    return event;
  });
  app.on("child-process-gone", (_event, details) =>
    collector.childExit(details),
  );
  // will-quit, not before-quit: a canceled quit must not truncate observation.
  app.on("will-quit", () => collector.finish(true));
  let trusted: BrowserWindow | undefined;
  let origin: string | undefined;
  let intervalStart = 0;
  let received = 0;
  ipcMain.on(DESKTOP_DIAGNOSTICS_CHANNEL, (event, value: unknown) => {
    try {
      if (
        !trusted ||
        trusted.isDestroyed() ||
        event.sender !== trusted.webContents ||
        event.senderFrame !== trusted.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== origin
      )
        return;
      if (Date.now() - intervalStart >= 1000) {
        intervalStart = Date.now();
        received = 0;
      }
      if (++received > 100) return;
      collector.record(value);
    } catch {
      /* Ignore malformed messages and destroyed frames. */
    }
  });
  return {
    bind(window: BrowserWindow, url: string) {
      trusted = window;
      origin = new URL(url).origin;
      window.webContents.on("render-process-gone", () =>
        collector.rendererGone(true),
      );
      window.webContents.on("did-navigate", () => collector.rendererGone());
      window.on("closed", () => {
        if (trusted === window) {
          trusted = undefined;
          collector.rendererGone();
        }
      });
    },
  };
}
