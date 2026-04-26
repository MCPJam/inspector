import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import {
  resolveEnvironment,
  resolveRelease,
  type RequestLogContext,
} from "../utils/log-events.js";
import { getRequestLogger } from "../utils/request-logger.js";
import { classifyError } from "../utils/error-classify.js";

const ENVIRONMENT = resolveEnvironment();
const RELEASE = resolveRelease();

const HEALTH_PATHS = new Set([
  "/api/mcp/health",
  "/api/apps/health",
  "/health",
]);

function isStreaming(c: Context): boolean {
  const ct = c.res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) return true;
  const te = c.res.headers.get("transfer-encoding") ?? "";
  if (te.toLowerCase().includes("chunked")) return true;
  return false;
}

export async function requestLogContextMiddleware(c: Context, next: Next) {
  const path = c.req.path;
  if (HEALTH_PATHS.has(path)) {
    return next();
  }

  const startedAt = Date.now();
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.res.headers.set("x-request-id", requestId);

  const baseContext: RequestLogContext = {
    event: "http.request.completed",
    timestamp: new Date().toISOString(),
    environment: ENVIRONMENT,
    release: RELEASE,
    component: "http",
    requestId,
    route: "pending",
    method: c.req.method,
    authType: "unknown",
  };

  c.set("requestLogContext", baseContext);

  let thrown: unknown = null;
  try {
    await next();
  } catch (err) {
    thrown = err;
  }

  // routePath is set by the matched handler after next(); read it now
  const route = c.req.routePath || "unmatched";

  if (isStreaming(c) && !thrown) {
    return;
  }

  const status = c.res.status;
  const durationMs = Date.now() - startedAt;
  const reqLogger = getRequestLogger(c, "http");

  const enriched: RequestLogContext = {
    ...c.var.requestLogContext,
    component: "http",
    route,
    durationMs,
    statusCode: status,
  };
  c.set("requestLogContext", enriched);

  const effectiveStatus = thrown
    ? thrown instanceof HTTPException ? thrown.status : 500
    : status;

  if (effectiveStatus >= 500) {
    reqLogger.event(
      "http.request.failed",
      {
        statusCode: effectiveStatus,
        errorCode: thrown ? classifyError(thrown) : "internal_error",
      },
      { error: thrown instanceof Error ? thrown : undefined, sentry: false },
    );
  } else {
    reqLogger.event("http.request.completed", { statusCode: effectiveStatus });
  }

  if (thrown) throw thrown;
}
