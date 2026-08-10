/**
 * A Convex HTTP client for a v1 route that calls Convex FUNCTIONS directly
 * rather than proxying whole requests.
 *
 * Lived twice, verbatim, in `journeys.ts` and `scenarios.ts`. Two copies is
 * two answers the day this needs a timeout, a retry policy, or a second
 * environment variable — and the copies would not diverge loudly, they would
 * diverge in one route.
 *
 * The `CONVEX_URL` check is a 500 rather than a throw at import time on
 * purpose: an Inspector with no Convex is a valid local install, and it should
 * fail on the routes that need Convex, not refuse to boot.
 */
import { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../web/errors.js";

export function createConvexClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}
