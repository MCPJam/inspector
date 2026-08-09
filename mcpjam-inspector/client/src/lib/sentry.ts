import * as Sentry from "@sentry/react";
import { clientSentryConfig } from "../../../shared/sentry-config";

/**
 * Initialize Sentry for error tracking and session replay.
 * This should be called once at app startup, before mounting React.
 */
export function initSentry() {
  Sentry.init({
    ...clientSentryConfig,
    integrations: [
      Sentry.replayIntegration(),
      Sentry.browserTracingIntegration(),
    ],
  });
}

/**
 * Report a caught problem that is worth an alert but must not stop the app.
 *
 * Thin wrapper over `Sentry.captureException` so callers do not each import
 * the SDK — and so the "we chose to keep running" cases are visibly one thing
 * rather than scattered raw SDK calls that read like error handling.
 */
export function captureSentryException(
  error: Error,
  context?: { tags?: Record<string, string> }
): void {
  Sentry.captureException(error, context);
}
