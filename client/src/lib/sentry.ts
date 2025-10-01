import * as Sentry from "@sentry/react";
import { sentryConfig } from "../../../shared/sentry-config";

/**
 * Initialize Sentry for error tracking and session replay.
 * This should be called once at app startup, before mounting React.
 */
export function initSentry() {
  Sentry.init({
    ...sentryConfig,
    integrations: [
      Sentry.replayIntegration(),
      Sentry.browserTracingIntegration()
    ],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}

