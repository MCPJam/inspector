import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { z } from "zod";
import { HOSTED_MODE } from "../config.js";
import { logger } from "../utils/logger.js";
import { serverCheckScope } from "../utils/server-check-scope.js";
import { abortableSleep } from "../utils/run-supervisor/backoff.js";
import { getServiceCredential } from "../services/service-credential.js";

const decisionSchema = z.object({
  state: z.enum([
    "active",
    "waiting",
    "full",
    "expired",
    "released",
    "preempted",
  ]),
  expiresAt: z.number(),
  active: z.number(),
  waiting: z.number(),
});
export type CheckDecision = z.infer<typeof decisionSchema>;
export type CheckOperation = "admit" | "poll" | "renew" | "release" | "promote";
export type CheckCoordinator = (
  operation: CheckOperation,
  signal?: AbortSignal,
) => Promise<CheckDecision>;

const COORDINATOR_CALL_TIMEOUT_MS = 5000;
// Release runs before the response is sent; a missed release just expires.
const RELEASE_CALL_TIMEOUT_MS = 2000;
const QUEUE_WINDOW_MS = 30_000;

function coordinatorFor(
  c: Context,
  metadata?: { requestId: string; intent?: "manual" | "automatic" },
): CheckCoordinator {
  const url = process.env.CONVEX_HTTP_URL;
  const serviceToken = getServiceCredential();
  const requestId = metadata?.requestId ?? randomUUID();
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
      body: JSON.stringify({
        principal,
        requestId,
        operation,
        intent: metadata?.intent,
      }),
      // Every Convex HTTP call costs ~0.4 s before it starts, and admit waits
      // up to 1 s for the lane worker, so 2 s left no room for network time.
      signal: AbortSignal.any([
        AbortSignal.timeout(
          operation === "release"
            ? RELEASE_CALL_TIMEOUT_MS
            : COORDINATOR_CALL_TIMEOUT_MS,
        ),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok)
      throw new Error(`Server check coordinator returned ${response.status}`);
    return decisionSchema.parse(await response.json());
  };
}

function refused(c: Context, reason: string, status: 409 | 429 | 503) {
  const message =
    status === 409
      ? "Automatic check queued to make room for a manual connection."
      : status === 429
        ? "Server checks are busy. Please retry shortly."
        : "Server check queue is temporarily unavailable.";
  const code =
    status === 409
      ? "SERVER_CHECK_PREEMPTED"
      : status === 429
        ? "RATE_LIMITED"
        : "INTERNAL_ERROR";
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
    // Before the body is read: the hosted Connect route counts its deadline
    // (`WEB_SERVER_CHECK_DEADLINE_MS`) from the request's arrival, so the body
    // read and the queue wait below both count against it.
    const arrivedAt = Date.now();
    let metadata:
      | { requestId: string; intent: "manual" | "automatic"; resumed?: boolean }
      | undefined;
    if (
      c.req.path.includes("/web/") &&
      c.req.path.endsWith("/servers/validate")
    ) {
      const body = await c.req.json().catch(() => null);
      const parsed = z
        .object({
          requestId: z.string().uuid(),
          intent: z.enum(["manual", "automatic"]),
          resumed: z.boolean().optional(),
        })
        .safeParse(body?._serverCheck);
      if (parsed.success) metadata = parsed.data;
    }
    const coordinator = makeCoordinator(c, metadata);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> | undefined;
    let done = false;
    let leaseFailed = false;
    let preempted = false;
    let preemptedAt: number | undefined;
    let renewedAt = Date.now();
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
            const renewDue = Date.now() - renewedAt >= 10_000;
            const decision = await coordinator(
              renewDue ? "renew" : "poll",
              signal,
            );
            if (done) return;
            if (decision.state === "preempted") {
              preempted = true;
              preemptedAt = Date.now();
              logger.info("[server-check.queue] preempted");
              controller.abort(new Error("SERVER_CHECK_PREEMPTED"));
              return;
            }
            if (decision.state !== "active") return loseLease();
            if (renewDue) renewedAt = Date.now();
            armWatchdog(decision.expiresAt);
            renew();
          } catch (error) {
            // One slow or failed heartbeat does not end a running check. The
            // lease stays ours until it expires; the watchdog ends the check
            // if no heartbeat succeeds before then.
            if (done || signal.aborted) return;
            logger.warn("[server-check.queue] heartbeat failed; retrying", {
              error: error instanceof Error ? error.message : String(error),
            });
            renew();
          }
        })();
      }, 1000);
    };
    // Admission calls are safe to repeat: Convex keeps a live request's place
    // for the same requestId. A slow or failed call is retried inside the
    // queue window instead of refusing the check.
    const admissionCall = async (operation: "admit" | "poll") => {
      for (;;) {
        try {
          return await coordinator(operation, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (Date.now() - started >= QUEUE_WINDOW_MS) throw error;
          logger.warn("[server-check.queue] admission call failed; retrying", {
            operation,
            error: error instanceof Error ? error.message : String(error),
          });
          await abortableSleep(
            Math.min(500, QUEUE_WINDOW_MS - (Date.now() - started)),
            signal,
          );
        }
      }
    };
    try {
      let decision = await admissionCall("admit");
      while (decision.state === "waiting") {
        if (Date.now() - started >= QUEUE_WINDOW_MS)
          return refused(c, "SERVER_CHECK_QUEUE_TIMEOUT", 429);
        await abortableSleep(
          Math.min(500, QUEUE_WINDOW_MS - (Date.now() - started)),
          signal,
        );
        if (Date.now() - started >= QUEUE_WINDOW_MS)
          return refused(c, "SERVER_CHECK_QUEUE_TIMEOUT", 429);
        decision = await admissionCall("poll");
      }
      if (decision.state === "preempted")
        return refused(c, "SERVER_CHECK_PREEMPTED", 409);
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
        intent: metadata?.intent ?? "manual",
        resumed: metadata?.resumed ?? false,
      });
      c.set("serverCheckStartedAt", arrivedAt);
      await serverCheckScope.run(signal, next);
      if (preempted) return refused(c, "SERVER_CHECK_PREEMPTED", 409);
      if (leaseFailed) return refused(c, "SERVER_CHECK_QUEUE_UNAVAILABLE", 503);
    } catch (error) {
      if (preempted) return refused(c, "SERVER_CHECK_PREEMPTED", 409);
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
        if (preemptedAt !== undefined)
          logger.info("[server-check.queue] preemption cleanup completed", {
            cleanupMs: Date.now() - preemptedAt,
          });
      } catch {
        logger.warn("[server-check.queue] release failed; lease will expire");
      }
    }
  };
}

// Keep the existing route registration name while replacing its old window
// counters with shared admission. There is no credential or IP time quota here.
export const mcpEgressRateLimitMiddleware = createServerCheckMiddleware();

// Mounted after the same verified bearer/guest authentication as validate.
export async function promoteServerCheck(c: Context) {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ requestId: z.string().uuid() }).safeParse(body);
  if (!parsed.success) return c.json({ code: "INVALID_REQUEST" }, 400);
  try {
    return c.json(
      await coordinatorFor(c, parsed.data)("promote", c.req.raw.signal),
    );
  } catch {
    return refused(c, "SERVER_CHECK_QUEUE_UNAVAILABLE", 503);
  }
}
