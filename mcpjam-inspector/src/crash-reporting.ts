import * as Sentry from "@sentry/electron/main";

/**
 * Exit reasons that mean the process died badly.
 *
 * `@sentry/electron`'s `childProcessIntegration` defaults to capturing only
 * `["abnormal-exit", "launch-failed", "integrity-failure"]` as EVENTS — the
 * remaining reasons (`crashed`, `oom`, `killed`) are recorded as breadcrumbs
 * only, which means they surface just as context on some LATER event and
 * produce no issue of their own. `crashed` and `oom` are ones a desktop user
 * actually experiences as "the app broke", so they are promoted to events
 * here.
 *
 * `killed` stays out: the OS kills Electron's own utility processes under
 * memory pressure on a busy machine, Electron respawns them, and the user
 * sees nothing. Capturing it produced issues about the reporter's hardware
 * rather than about the app. It remains a breadcrumb, so it still shows up
 * as context if a real failure follows.
 *
 * `clean-exit` stays out: that is a normal shutdown.
 */
export const CAPTURED_EXIT_REASONS = [
  "abnormal-exit",
  "launch-failed",
  "integrity-failure",
  "crashed",
  "oom",
] as const;

/**
 * The one rejection `installUpdateOnQuit` provably cannot catch.
 *
 * INSPECTOR-ELECTRON-WK. On Windows, Electron's `quitAndInstall` is:
 *
 *     quitAndInstall() {
 *       if (!this.updateAvailable) { return this.emitError(...); }
 *       squirrelUpdate.processStart();   // floating promise, never awaited
 *       app.quit();
 *     }
 *
 * `processStart()` spawns `Update.exe --processStartAndWait`, and
 * `spawnUpdate` REJECTS when a different Update.exe invocation is still
 * running (`spawnedProcess && !isSameArgs(args)`) — a check or download that
 * had not finished when the user quit. Electron neither awaits that promise
 * nor emits `error` for it, so:
 *
 * - the synchronous `try/catch` around `quitAndInstall()` cannot see it,
 * - there is no promise handle to attach a `.catch()` to,
 * - it lands on `process.on("unhandledRejection")` and is reported as an
 *   unhandled error.
 *
 * Which is a lie about what happened. `app.quit()` runs regardless, so the
 * app closes normally; the staged update is simply not applied that once and
 * is offered again on the next launch. Nothing crashed, nothing is in an
 * undefined state, and no code of ours was negligent — there is no version of
 * this app that can handle that promise.
 *
 * Matching the message and not a flag, because this string can only come from
 * `processStart`, which only runs from `quitAndInstall`. There is no other
 * caller to confuse it with.
 */
const UPDATER_INSTALL_SPAWN_COLLISION =
  /AutoUpdater process with arguments .* is already running/;

export function isUpdaterInstallSpawnRejection(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "";
  return UPDATER_INSTALL_SPAWN_COLLISION.test(message);
}

/** Minimal structural view of the event, mirroring `FingerprintableEvent` in
 *  `shared/sentry-config.ts` — declared rather than imported so this module
 *  keeps its single `@sentry/electron/main` dependency. */
export interface SendableEvent {
  exception?: {
    values?: { type?: string; value?: string }[];
  };
}

/**
 * Drop the skipped-install rejection, keeping every other one.
 *
 * A `beforeSend` and not an `ignoreErrors` entry: `ignoreErrors` is a blunt
 * substring match over every event, and `buildElectronSentryConfig` documents
 * at length why the main process deliberately carries none — the strings that
 * are noise in a browser are real updater failures here. This drops exactly
 * one known-benign shape and leaves that property intact.
 *
 * It costs the Sentry-side count of how often an install is skipped. That is
 * the trade: `registerMainProcessCrashHandlers` logs the same rejection to
 * electron-log, which is the file a user attaches to a bug report, so the
 * evidence survives where a reader would look for it. If the skipped installs
 * ever need counting, the honest way is a deliberate low-level capture, not
 * leaving a benign condition masquerading as an unhandled rejection.
 */
export function dropUpdaterInstallSpawnRejection<T extends SendableEvent>(
  event: T,
): T | null {
  const value = event.exception?.values?.[0]?.value ?? "";
  return UPDATER_INSTALL_SPAWN_COLLISION.test(value) ? null : event;
}

interface CrashLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Process-level handlers for the Electron main process.
 *
 * Sentry's default `onUncaughtException` / `onUnhandledRejection` integrations
 * already CAPTURE these. What they don't do is write to `electron-log`, which
 * is the file a user attaches to a bug report and the only diagnostic
 * available when the crash happens offline or with reporting opted out. That
 * is what this adds — deliberately not a second capture.
 *
 * Every listener body is wrapped: an exception thrown from inside an
 * `uncaughtException` handler is unrecoverable, and a logger that throws must
 * not be what takes the app down.
 */
export function registerMainProcessCrashHandlers(log: CrashLogger): void {
  process.on("uncaughtException", (error) => {
    try {
      log.error("[main] uncaught exception", error);
    } catch {
      // A failing logger must not escalate an already-fatal path.
    }
  });

  process.on("unhandledRejection", (reason) => {
    try {
      if (isUpdaterInstallSpawnRejection(reason)) {
        // Not a crash, and not ours to catch — see the predicate. Logged as
        // its own line so the log says what actually happened (an update was
        // skipped) rather than filing it under unhandled rejections, and so
        // the evidence is still here after `dropUpdaterInstallSpawnRejection`
        // keeps it out of Sentry.
        log.warn(
          "[main] staged update not applied at quit: another Update.exe was " +
            "still running. The app quit normally; the update will be " +
            "offered again on the next launch.",
          reason,
        );
        return;
      }
      log.error("[main] unhandled rejection", reason);
    } catch {
      // See above.
    }
  });
}

/**
 * Renderer/child-process death reporting.
 *
 * `childProcessIntegration` is configured (not replaced) so the crash-shaped
 * reasons become events. Registering our own `app.on("render-process-gone")`
 * instead would double-report every reason the integration already covers.
 */
export function childProcessIntegrationOptions() {
  return {
    events: [...CAPTURED_EXIT_REASONS],
  };
}

export function crashReportingIntegrations(
  defaults: { name: string }[],
): { name: string }[] {
  return [
    ...defaults.filter(
      (i) => i.name !== "ChildProcess" && i.name !== "OnUncaughtException",
    ),
    Sentry.childProcessIntegration(childProcessIntegrationOptions()),
    // Forced exit, for the same reason as the server: Sentry only terminates
    // when no other `uncaughtException` listener is registered, and
    // `registerMainProcessCrashHandlers` registers one. Without this the app
    // would capture a fatal main-process error, log it, and then keep running
    // in an undefined state instead of showing the crash and dying.
    Sentry.onUncaughtExceptionIntegration({
      exitEvenIfOtherHandlersAreRegistered: true,
    }),
  ];
}
