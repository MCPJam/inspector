import type { Context } from "hono";
import type {
  RequestLogContext,
  RequestEventMap,
  SystemLogContext,
  SystemEventMap,
} from "./log-events.js";
import { logger } from "./logger.js";

export function getRequestLogger(c: Context, component: string) {
  return {
    event<E extends keyof RequestEventMap>(
      eventName: E,
      payload: RequestEventMap[E],
      options?: { error?: unknown; sentry?: boolean },
    ): void {
      const base: RequestLogContext = {
        ...(c.var.requestLogContext as RequestLogContext),
        component,
      };
      logger.event(eventName, base, payload, options);
    },
  };
}

export function getSystemLogger(component: string) {
  return {
    event<E extends keyof SystemEventMap>(
      eventName: E,
      partial: Omit<SystemLogContext, "event" | "timestamp" | "component"> &
        Partial<Pick<SystemLogContext, "component">>,
      payload: SystemEventMap[E],
      options?: { error?: unknown; sentry?: boolean },
    ): void {
      const base: SystemLogContext = {
        ...partial,
        component,
        event: eventName,
        timestamp: new Date().toISOString(),
      } as SystemLogContext;
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
