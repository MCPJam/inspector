import * as Sentry from "@sentry/react";

/**
 * Initialize Sentry for error tracking and session replay.
 * This should be called once at app startup, before mounting React.
 */
export function initSentry() {
  Sentry.init({
    dsn: "https://c9df3785c734acfe9dad2d0c1e963e28@o4510109778378752.ingest.us.sentry.io/4510111435063296",
    sendDefaultPii: true,
    integrations: [Sentry.replayIntegration(), Sentry.browserTracingIntegration()],
    replaysSessionSampleRate: 0.1, 
    replaysOnErrorSampleRate: 1.0, 
    tracesSampleRate: 0.1,
    tracePropagationTargets: [
      "localhost",
      /^\//,  // All relative URLs (for local API routes like /api/mcp/chat)
      /^https:\/\/.*\.convex\.(cloud|site)/,  // Convex backend
    ],
  });
}

