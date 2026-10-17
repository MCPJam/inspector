import type { MiddlewareHandler } from "hono";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import {
  serverDrain,
  type DrainCoordinator,
  type InFlightKind,
} from "./drain.js";

/**
 * Seconds a refused caller is asked to wait. Short: a draining process is on
 * its way out, and the deployment replacing it is normally serving already.
 */
export const DRAINING_RETRY_AFTER_SECONDS = 5;

/**
 * Refuses to start new work once this process is draining. The drain only
 * waits for work already accepted; a run started now would stretch it or be
 * cut by the teardown that follows.
 *
 * The answer a full concurrency slot already gives (`RATE_LIMITED`, with the
 * reason in `details`) plus `Retry-After`, because to the caller it is the
 * same situation: nothing is wrong with the request, this process cannot take
 * it right now, and the same call shortly will succeed.
 */
export function assertAdmitting(drain: DrainCoordinator = serverDrain): void {
  if (!drain.isDraining()) return;
  throw new WebRouteError(
    429,
    ErrorCode.RATE_LIMITED,
    "This server is restarting. Try again in a few seconds.",
    { reason: "SERVER_DRAINING" },
  ).withHeaders({ "Retry-After": String(DRAINING_RETRY_AFTER_SECONDS) });
}

/**
 * `assertAdmitting` as middleware, for a router to list the routes that start
 * work; the router's own error handler renders the refusal in its envelope.
 *
 * An admitted request holds the drain until its handler returns. A launch is
 * accepted here but registers its run only once it detaches, after auth, MCP
 * connections and the backend writes; a drain that began in between would
 * find nothing to wait for and close those connections under it. Work the
 * handler leaves running once it returns is held only if it registers itself
 * before then, as a detached run has to.
 */
export function refuseWhileDraining(
  kind: InFlightKind,
  drain?: DrainCoordinator,
): MiddlewareHandler {
  return async (_c, next) => {
    // Resolved per request, not when the router is built at import, so it
    // follows a process drain replaced after the routers load.
    const coordinator = drain ?? serverDrain;
    assertAdmitting(coordinator);
    await coordinator.track(kind, next());
  };
}

/**
 * The internal doorbells' form. They have no error envelope, and a refused
 * ring costs nothing: the backend's sweep re-delivers whatever it asked for,
 * which is what makes the doorbells reliable at all.
 */
export function refuseDoorbellWhileDraining(
  drain: DrainCoordinator = serverDrain,
): MiddlewareHandler {
  return async (c, next) => {
    if (!drain.isDraining()) return next();
    c.header("Retry-After", String(DRAINING_RETRY_AFTER_SECONDS));
    return c.json({ ok: false, error: "This server is restarting." }, 503);
  };
}
