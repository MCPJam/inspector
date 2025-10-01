import * as Sentry from "@sentry/node";
import { serverSentryConfig } from "../shared/sentry-config";

/**
 * Initialize Sentry for the Hono server.
 * This should be imported at the very top of server/index.ts before any other imports.
 */
Sentry.init(serverSentryConfig);
