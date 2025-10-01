import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { sentryConfig } from "../shared/sentry-config";

/**
 * Initialize Sentry for the Hono server.
 * This should be imported at the very top of server/index.ts before any other imports.
 */
Sentry.init({
  ...sentryConfig,
  integrations: [nodeProfilingIntegration()],
  profilesSampleRate: 0.1,
});
