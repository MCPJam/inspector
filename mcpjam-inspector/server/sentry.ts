import * as Sentry from "@sentry/node";
import { buildServerSentryConfig } from "../shared/sentry-config.js";
import { resolveEnvironment } from "./utils/log-events.js";

/**
 * Initialize Sentry for the Hono server.
 * This should be imported at the very top of server/index.ts before any other imports.
 */
Sentry.init(
  buildServerSentryConfig({
    environment: resolveEnvironment(),
    release: process.env.MCPJAM_INSPECTOR_VERSION,
    deployment:
      process.env.VITE_MCPJAM_HOSTED_MODE === "true" ? "hosted" : "self_hosted",
  }),
);
