import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import {
  resolveEnvironment,
  resolveRelease,
  type RequestLogContext,
} from "../utils/log-events.js";
import { getRequestLogger } from "../utils/request-logger.js";
import { logger } from "../utils/logger.js";
import { classifyError } from "../utils/error-classify.js";

// Exact-match health endpoints we know about; anything else ending in
// "/health" or "/healthz" is also treated as a probe.
const EXACT_HEALTH_PATHS = new Set([
  "/api/mcp/health",
  "/api/apps/health",
  "/health",
]);

function isHealthPath(path: string): boolean {
  const normalized = path.endsWith("/") && path.length > 1
    ? path.slice(0, -1)
    : path;
  if (EXACT_HEALTH_PATHS.has(normalized)) return true;
  return normalized.endsWith("/health") || normalized.endsWith("/healthz");
}

function isStreaming(c: Context): boolean {
  const ct = c.res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) return true;
  const te = c.res.headers.get("transfer-encoding") ?? "";
  if (te.toLowerCase().includes("chunked")) return true;
  return false;
}

export async function requestLogContextMiddleware(c: Context, next: Next) {
  if (isHealthPath(c.req.path)) {
    return next();
  }

  const startedAt = Date.now();
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.header("x-request-id", requestId);

  const baseContext: RequestLogContext = {
    event: "http.request.completed",
    timestamp: new Date().toISOString(),
    environment: resolveEnvironment(),
    release: resolveRelease(),
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

  const status = c.res.status;
  const reqLogger = getRequestLogger(c, "http");

  const enriched: RequestLogContext = {
    ...(c.var.requestLogContext as RequestLogContext),
    component: "http",
    route,
    statusCode: status,
  };
  c.set("requestLogContext", enriched);

  // Streaming responses: emit `http.stream.opened` synchronously, and wrap
  // the body with a TransformStream so we can emit `http.stream.closed` with
  // the actual stream lifetime when the consumer finishes reading. Without
  // this, SSE/MCP routes would generate zero telemetry.
  if (isStreaming(c) && !thrown) {
    reqLogger.event("http.stream.opened", { statusCode: status });

    const body = c.res.body;
    if (body) {
      const closedCtx: RequestLogContext = { ...enriched };
      const ts = new TransformStream({
        flush() {
          const durationMs = Date.now() - startedAt;
          logger.event(
            "http.stream.closed",
            { ...closedCtx, durationMs },
            { statusCode: closedCtx.statusCode ?? status, durationMs },
          );
        },
      });
      c.res = new Response(body.pipeThrough(ts), {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: c.res.headers,
      });
    }
    return;
  }

  const durationMs = Date.now() - startedAt;
  c.set("requestLogContext", { ...enriched, durationMs });

  const effectiveStatus = thrown
    ? thrown instanceof HTTPException
      ? thrown.status
      : 500
    : status;

  if (effectiveStatus >= 500) {
    // Sentry capture is owned by the route's error handler / Sentry middleware;
    // we deliberately don't forward here (default is sentry: false) to avoid
    // double-capture for the same exception.
    reqLogger.event(
      "http.request.failed",
      {
        statusCode: effectiveStatus,
        errorCode: thrown ? classifyError(thrown) : "internal_error",
      },
      { error: thrown instanceof Error ? thrown : undefined },
    );
  } else {
    reqLogger.event("http.request.completed", {
      statusCode: effectiveStatus,
    });
  }

  if (thrown) throw thrown;
}
