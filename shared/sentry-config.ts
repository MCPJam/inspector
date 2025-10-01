/**
 * Shared Sentry configuration for all processes:
 * - Node.js server (standalone npm)
 * - Electron main process
 * - Electron renderer process (client)
 */
export const sentryConfig = {
  dsn: "https://c9df3785c734acfe9dad2d0c1e963e28@o4510109778378752.ingest.us.sentry.io/4510111435063296",
  sendDefaultPii: true,
  tracesSampleRate: 0.1,
  tracePropagationTargets: [
    "localhost",
    /^\//,  // All relative URLs (includes /api/*, /sse/message, /health, etc.)
    /^https?:\/\/[^/]*\.convex\.(cloud|site)/,  // Convex backend
  ],
};
