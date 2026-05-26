import type { Context } from "hono";
import {
  resolveEnvironment,
  resolveRelease,
  type RequestLogContext,
  type RequestEventMap,
  type SystemLogContext,
  type SystemEventMap,
} from "./log-events.js";
import { logger } from "./logger.js";

type SentryOptions = { error?: unknown; sentry?: boolean };

/**
 * Returns a request-scoped logger that auto-attaches the per-request
 * `RequestLogContext` populated by `requestLogContextMiddleware`.
 *
 * Throws if the middleware did not run for this route. That signals a real
 * wiring bug (callsite is mounted outside `/api/*`, or the middleware is
 * missing) — failing loudly here prevents emitting events with malformed
 * envelopes that would otherwise pass type checks.
 */
export function getRequestLogger(c: Context, component: string) {
  return {
    event<E extends keyof RequestEventMap>(
      eventName: E,
      payload: RequestEventMap[E],
      options?: SentryOptions,
    ): void {
      const ctx = c.var.requestLogContext;
      if (!ctx) {
        throw new Error(
          `getRequestLogger("${component}") called without requestLogContext — ` +
            `is requestLogContextMiddleware mounted on this route?`,
        );
      }
      logger.event(eventName, { ...ctx, component }, payload, options);
    },
  };
}

/**
 * Returns a system logger pre-bound to a component. The system envelope
 * (environment, release, requestId/route/method nulls, authType "system") is
 * filled automatically — callers only pass the event name and payload.
 */
export function getSystemLogger(component: string) {
  return {
    event<E extends keyof SystemEventMap>(
      eventName: E,
      payload: SystemEventMap[E],
      options?: SentryOptions,
    ): void {
      const base: SystemLogContext = {
        event: eventName,
        timestamp: new Date().toISOString(),
        environment: resolveEnvironment(),
        release: resolveRelease(),
        component,
        requestId: null,
        route: null,
        method: null,
        authType: "system",
      };
      logger.systemEvent(eventName, base, payload, options);
    },
  };
}

export function setRequestLogContext(
  c: Context,
  partial: Partial<RequestLogContext>,
): void {
  const current = c.var.requestLogContext;
  if (!current) return;
  c.set("requestLogContext", { ...current, ...partial });
}
