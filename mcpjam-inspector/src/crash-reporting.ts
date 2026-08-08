import * as Sentry from "@sentry/electron/main";

/**
 * Exit reasons that mean the process died badly.
 *
 * `@sentry/electron`'s `childProcessIntegration` defaults to capturing only
 * `["abnormal-exit", "launch-failed", "integrity-failure"]` as EVENTS — the
 * remaining reasons (`crashed`, `oom`, `killed`) are recorded as breadcrumbs
 * only, which means they surface just as context on some LATER event and
 * produce no issue of their own. Those three are the ones a desktop user
 * actually experiences as "the app broke", so they are promoted to events
 * here.
 *
 * `clean-exit` stays out: that is a normal shutdown.
 */
export const CAPTURED_EXIT_REASONS = [
  "abnormal-exit",
  "launch-failed",
  "integrity-failure",
  "crashed",
  "oom",
  "killed",
] as const;

interface CrashLogger {
  error: (...args: unknown[]) => void;
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
    ...defaults.filter((i) => i.name !== "ChildProcess"),
    Sentry.childProcessIntegration(childProcessIntegrationOptions()),
  ];
}
