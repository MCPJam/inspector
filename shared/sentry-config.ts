const baseSentryConfig = {
  environment: process.env.NODE_ENV === "production" ? "prod" : "dev",
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  tracePropagationTargets: [
    "localhost",
    /^\//, // All relative URLs (includes /api/*, /sse/message, /health, etc.)
    /^https?:\/\/[^/]*\.convex\.(cloud|site)/, // Convex backend
  ],
};

export const electronSentryConfig = {
  ...baseSentryConfig,
  dsn: "https://6a41a208e72267f181f66c47138f2b9d@o4510109778378752.ingest.us.sentry.io/4510112190431232",
};
export const serverSentryConfig = {
  ...baseSentryConfig,
  dsn: "https://ec309069e18ebe1d0be9088fa7bf56d9@o4510109778378752.ingest.us.sentry.io/4510112186433536",
};
export const clientSentryConfig = {
  ...baseSentryConfig,
  dsn: "https://c9df3785c734acfe9dad2d0c1e963e28@o4510109778378752.ingest.us.sentry.io/4510111435063296",
  replaysSessionSampleRate: 0.1, // Session replay sample rate
  replaysOnErrorSampleRate: 1.0, // Always capture replay on error
};
