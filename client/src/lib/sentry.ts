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
