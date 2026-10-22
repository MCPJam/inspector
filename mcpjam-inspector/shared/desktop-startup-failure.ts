/**
 * What the desktop app reports when it still could not start after its
 * automatic restart. Declared here, not next to the Electron code, because the
 * telemetry catalog only collects diagnostic codes from `shared/` and the SDK
 * (`CODE_LISTS` in `scripts/generate-telemetry-catalogs.mjs`); these are the
 * `code` values the strict Sentry boundary forwards for that event.
 */
export const DESKTOP_STARTUP_FAILURE_CODES = [
  "port_taken",
  "no_free_port",
  "startup_failed",
] as const;

export type DesktopStartupFailureCode =
  (typeof DESKTOP_STARTUP_FAILURE_CODES)[number];
