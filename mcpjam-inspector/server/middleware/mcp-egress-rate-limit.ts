import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { z } from "zod";
import { HOSTED_MODE } from "../config.js";
import { logger } from "../utils/logger.js";
import { serverCheckScope } from "../utils/server-check-scope.js";
import { abortableSleep } from "../utils/run-supervisor/backoff.js";

const decisionSchema = z.object({
  state: z.enum(["active", "waiting", "full", "expired", "released"]),
  expiresAt: z.number(),
  active: z.number(),
  waiting: z.number(),
});
export type CheckDecision = z.infer<typeof decisionSchema>;
export type CheckOperation = "admit" | "poll" | "renew" | "release";
export type CheckCoordinator = (
  operation: CheckOperation,
  signal?: AbortSignal,
) => Promise<CheckDecision>;

function coordinatorFor(c: Context): CheckCoordinator {
  const url = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  const requestId = randomUUID();
  const guestId = c.get("guestId");
  const userId = c.get("workosUserId");
  const principal = guestId
    ? `guest:${guestId}`
    : userId
      ? `user:${userId}`
      : undefined;
  return async (operation, signal) => {
    if (!url || !serviceToken)
      throw new Error("Server check coordinator is not configured");
    const response = await fetch(`${url}/internal/server-check-queue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": serviceToken,
        ...(principal === undefined && c.req.header("authorization")
          ? { authorization: c.req.header("authorization")! }
          : {}),
      },
      body: JSON.stringify({ principal, requestId, operation }),
      signal: AbortSignal.any([
        AbortSignal.timeout(2000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok)
      throw new Error(`Server check coordinator returned ${response.status}`);
    return decisionSchema.parse(await response.json());
  };
}

function refused(c: Context, reason: string, status: 429 | 503) {
  const message =
    status === 429
      ? "Server checks are busy. Please retry shortly."
      : "Server check queue is temporarily unavailable.";
  const code = status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR";
  c.set("webErrorMeta", { status, code, message });
  logger.info("[server-check.queue] refused", { reason, status });
  const response = c.json({ code, message, details: { reason } }, status, {
    "Retry-After": "2",
  });
  c.res = response;
  return response;
}

export function createServerCheckMiddleware(makeCoordinator = coordinatorFor) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!HOSTED_MODE || c.req.method !== "POST") return next();
    const coordinator = makeCoordinator(c);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> | undefined;
    let done = false;
    let leaseFailed = false;
    const started = Date.now();
    const loseLease = () => {
      logger.warn("[server-check.queue] lease lost; aborting check");
      leaseFailed = true;
      controller.abort(new Error("Server check lease lost"));
    };
    const armWatchdog = (expiresAt: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        loseLease,
        Math.max(0, expiresAt - Date.now() - 2000),
      );
    };
    const renew = () => {
      heartbeat = setTimeout(() => {
        renewing = (async () => {
          try {
            const decision = await coordinator("renew", signal);
            if (done) return;
            if (decision.state !== "active") return loseLease();
            armWatchdog(decision.expiresAt);
            renew();
          } catch {
            if (!done) loseLease();
          }
        })();
      }, 10_000);
    };
    try {
      let decision = await coordinator("admit", signal);
      while (decision.state === "waiting") {
        if (Date.now() - started >= 30_000)
          return refused(c, "SERVER_CHECK_QUEUE_TIMEOUT", 429);
        await abortableSleep(
          Math.min(500, 30_000 - (Date.now() - started)),
          signal,
        );
        if (Date.now() - started >= 30_000)
          return refused(c, "SERVER_CHECK_QUEUE_TIMEOUT", 429);
        decision = await coordinator("poll", signal);
      }
      if (decision.state === "full")
        return refused(c, "SERVER_CHECK_QUEUE_FULL", 429);
      if (decision.state === "expired")
        return refused(c, "SERVER_CHECK_QUEUE_TIMEOUT", 429);
      if (decision.state !== "active")
        throw new Error("Invalid check admission");
      signal.throwIfAborted();
      armWatchdog(decision.expiresAt);
      renew();
      logger.info("[server-check.queue] admitted", {
        active: decision.active,
        waiting: decision.waiting,
        waitedMs: Date.now() - started,
      });
      await serverCheckScope.run(signal, next);
      if (leaseFailed) return refused(c, "SERVER_CHECK_QUEUE_UNAVAILABLE", 503);
    } catch (error) {
      if (c.req.raw.signal.aborted) throw error;
      logger.warn("[server-check.queue] unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return refused(c, "SERVER_CHECK_QUEUE_UNAVAILABLE", 503);
    } finally {
      done = true;
      clearTimeout(heartbeat);
      clearTimeout(watchdog);
      await renewing;
      // Release is independent of the disconnected request's abort signal.
      try {
        await coordinator("release");
      } catch {
        logger.warn("[server-check.queue] release failed; lease will expire");
      }
    }
  };
}

// Keep the existing route registration name while replacing its old window
// counters with shared admission. There is no credential or IP time quota here.
export const mcpEgressRateLimitMiddleware = createServerCheckMiddleware();
