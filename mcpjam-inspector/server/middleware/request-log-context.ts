import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";
import { randomUUID } from "node:crypto";
import {
  resolveEnvironment,
  resolveRelease,
  type RequestLogContext,
} from "../utils/log-events.js";
import { getRequestLogger } from "../utils/request-logger.js";
import { logger } from "../utils/logger.js";
import { classifyError } from "../utils/error-classify.js";
import { describeError } from "@mcpjam/sdk";
import { maybeCaptureOriginError } from "../utils/error-origin-capture.js";
import {
  agentCapturePolicy,
  isAgentRequestPath,
} from "../utils/agent-failure-capture.js";

/**
 * Whether the server sent a failure on this request to Sentry: `1` or `0`.
 * Set on every Ask MCPJam response so the client reports exactly what the
 * server did not.
 */
export const FAILURE_CAPTURED_HEADER = "x-mcpjam-failure-captured";

function setFailureCapturedHeader(c: Context, captured: boolean): void {
  const value = captured ? "1" : "0";
  try {
    c.res.headers.set(FAILURE_CAPTURED_HEADER, value);
  } catch {
    // An immutable header set (a proxied fetch Response). Re-wrap once.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set(FAILURE_CAPTURED_HEADER, value);
  }
}

/**
 * The BACKSTOP for Ask MCPJam: every ≥400 its routes answer reaches Sentry.
 *
 * Extends this middleware rather than adding one, because it is the one place
 * that already sees every response, including the ones no route catch ever
 * held — the bearer 401 and the guest and passthrough 429s are answered by
 * middleware in front of the route.
 *
 * Captures only what was not already captured, by the RECORDED outcome:
 * `webErrorMeta.captured` for a route's own decision, `failureCaptured` for a
 * request-scoped stream reporter's. The capture stamp is not consulted — it
 * says a decision was made, and a decline makes one too. Never throws.
 */
function captureUnreportedAgentFailure(
  c: Context,
  status: number,
  meta: { code?: string; message?: string } | undefined,
  route: string,
): boolean {
  try {
    const error = new Error(
      `Ask MCPJam request failed: ${status}${meta?.code ? ` ${meta.code}` : ""}`,
    );
    return maybeCaptureOriginError(error, describeError(error), {
      source: "route:request-log.agent-backstop",
      extra: {
        status,
        route,
        ...(meta?.code ? { code: meta.code } : {}),
        ...(meta?.message ? { message: meta.message.slice(0, 500) } : {}),
        requestId: c.res.headers.get("x-request-id") ?? undefined,
      },
      capture: agentCapturePolicy({
        source: "request-log.agent-backstop",
        httpStatus: status,
        ...(meta?.code ? { code: meta.code } : {}),
      }),
    }).captured;
  } catch {
    return false;
  }
}

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

// Inbound `x-request-id` is reflected in the response and stored in every
// emitted log event. Without a guard, an attacker could forge log lines with
// embedded newlines/control chars, blow up logging-backend cardinality with
// arbitrarily long values, or inject characters that break downstream queries.
// Accept the inbound value only if it matches a conservative shape; otherwise
// mint a fresh UUID.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Make a caller-supplied user-agent safe to put in a log row.
 *
 * Two hazards and a distinction, the same shape as the `x-request-id` guard
 * above. An unbounded string bloats every row and the backend's index with it —
 * real agents send a few dozen characters, and a four-kilobyte tail is either a
 * bug or an attempt. Tabs and whitespace runs make one agent read as several in
 * a group-by, which is the whole reason to record the field. And an empty
 * header is not a user-agent; it is a caller who sent none, which the row says
 * by omitting the field rather than by carrying a blank one.
 *
 * The control-character strip is the SECOND line, not the only one: NUL and
 * CRLF — the characters that would let a caller forge a log line — are rejected
 * by the HTTP parser before this middleware ever runs. It stays because a
 * sanitizer that depends on an upstream layer staying strict is one deploy away
 * from being wrong.
 */
function sanitizeUserAgent(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  return cleaned.length > 0 ? cleaned : undefined;
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
  const userAgent = sanitizeUserAgent(c.req.header("user-agent"));
  const inboundRequestId = c.req.header("x-request-id");
  const requestId =
    inboundRequestId && REQUEST_ID_PATTERN.test(inboundRequestId)
      ? inboundRequestId
      : randomUUID();
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
    ...(userAgent ? { userAgent } : {}),
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
  // A middleware that answers first (a rate limiter's 429) leaves `route` at
  // its own mount pattern. The next concrete route after it is the handler the
  // request was headed for, as a pattern, so path parameters never reach the
  // log. Later wildcards (the dev `/*` mount, the SPA fallback) are not it.
  const targetRoute = route.endsWith("*")
    ? matchedRoutes(c)
        .slice(c.req.routeIndex + 1)
        .find((r) => !r.path.endsWith("*"))?.path
    : undefined;

  const status = c.res.status;
  const reqLogger = getRequestLogger(c, "http");

  const enriched: RequestLogContext = {
    ...(c.var.requestLogContext as RequestLogContext),
    component: "http",
    route,
    ...(targetRoute ? { targetRoute } : {}),
    statusCode: status,
  };
  c.set("requestLogContext", enriched);

  // Streaming responses: emit `http.stream.opened` synchronously, and wrap
  // the body with a TransformStream so we can emit `http.stream.closed` with
  // the actual stream lifetime when the consumer finishes reading. Without
  // this, SSE/MCP routes would generate zero telemetry.
  if (isStreaming(c) && !thrown) {
    reqLogger.event("http.stream.opened", { statusCode: status });
    // A stream fails AFTER these headers leave, so "0" here means only that
    // nothing failed before it opened. Its later failures say whether they
    // were captured on their own error trace events.
    if (isAgentRequestPath(c.req.path)) setFailureCapturedHeader(c, false);

    const body = c.res.body;
    if (body) {
      const closedCtx: RequestLogContext = { ...enriched };
      // Hand-rolled pull wrapper instead of a TransformStream: flush() only
      // runs on a NORMAL end-of-stream, so a producer error or a client
      // disconnect used to leave no `http.stream.closed` at all — the most
      // common streaming failure produced zero telemetry. read()/cancel()
      // cover all three exits deterministically, and pull() is demand-driven
      // so backpressure is preserved.
      const reader = body.getReader();
      let closedEmitted = false;
      const emitClosed = (
        outcome: "completed" | "aborted" | "errored",
        error?: unknown,
      ) => {
        // Exactly once: cancel and a pending read rejection can race.
        if (closedEmitted) return;
        closedEmitted = true;
        const durationMs = Date.now() - startedAt;
        // Guarded extraction: a rejection reason can be a value whose
        // message getter or string coercion throws (Proxy trap, null-proto
        // object). Letting that escape here would swallow the closed row AND
        // replace the stream error with a secondary failure from the
        // telemetry code — same precedent as reportRouteFailure's
        // "[unreadable error value]" handling.
        let errorMessage: string | undefined;
        if (outcome === "errored" && error !== undefined) {
          try {
            errorMessage = (
              error instanceof Error ? error.message : String(error)
            ).slice(0, 500);
          } catch {
            errorMessage = "[unreadable error value]";
          }
        }
        logger.event(
          "http.stream.closed",
          { ...closedCtx, durationMs },
          {
            statusCode: closedCtx.statusCode ?? status,
            durationMs,
            outcome,
            ...(errorMessage ? { errorMessage } : {}),
          },
        );
      };
      const wrapped = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              emitClosed("completed");
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            emitClosed("errored", err);
            controller.error(err);
          }
        },
        cancel(reason) {
          emitClosed("aborted", reason);
          return reader.cancel(reason);
        },
      });
      c.res = new Response(wrapped, {
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

  // Ask MCPJam: capture what nothing else did, and say so on the response.
  // A throw is left to `onError`, which reports it on its own path; 499 is
  // the client going away, which is the user pressing Stop.
  if (!thrown && isAgentRequestPath(c.req.path)) {
    const meta =
      c.var.webErrorMeta?.status === effectiveStatus
        ? c.var.webErrorMeta
        : undefined;
    let captured =
      meta?.captured === true || c.var.failureCaptured === true;
    if (!captured && effectiveStatus >= 400 && effectiveStatus !== 499) {
      captured = captureUnreportedAgentFailure(
        c,
        effectiveStatus,
        meta,
        targetRoute ?? route,
      );
    }
    setFailureCapturedHeader(c, captured);
  }

  // 424 joins the 5xx range as a FAILURE for logging purposes. It is the one
  // 4xx this server emits for "we could not reach the dependency the request
  // named" (`mapTargetServerError`), which is a failed request in every sense
  // except whose fault it was. Without this it would log as
  // `http.request.completed` and lose the `errorCode` / `origin` / `slug` /
  // `errorMessage` breakdown below — and that Axiom slice is exactly what
  // makes an unpaged `ambiguous` bucket measurable, i.e. what lets the bucket
  // be promoted later as a data decision rather than a guess. Moving these
  // failures out of the 5xx range to stop them paging us must not also move
  // them out of the record that says how often they happen.
  if (effectiveStatus >= 500 || effectiveStatus === 424) {
    // Prefer the route's own error code/message over a classifier bucket. A
    // route that *returns* a `webError` response (the hosted connect paths do)
    // never reaches the `thrown` branch, so both of these used to collapse to a
    // bare "internal_error" with the cause discarded. `scrubLogPayload` strips
    // bearers/JWTs/emails from the message at emit time.
    // Only trust the stashed meta when it belongs to *this* status — a route
    // may emit a 4xx `webError` and then fail with an unrelated 500 later.
    const webErrorMeta =
      c.var.webErrorMeta?.status === effectiveStatus
        ? c.var.webErrorMeta
        : undefined;
    const errorCode = thrown
      ? classifyError(thrown)
      : (webErrorMeta?.code ?? "internal_error");
    const rawErrorMessage = thrown
      ? thrown instanceof Error
        ? thrown.message
        : String(thrown)
      : webErrorMeta?.message;
    // Cap the message: SDK connect errors sometimes embed the upstream
    // response body ("Error POSTing to endpoint (HTTP 502): <html>…"), and an
    // unbounded string would bloat the log line. 500 chars keeps the cause.
    const errorMessage = rawErrorMessage?.slice(0, 500);

    // Sentry capture is owned by `Hono.onError` -> `logger.error` (there is no
    // Sentry middleware). We deliberately don't forward here (default is
    // sentry: false) to avoid double-capture for the same exception.
    reqLogger.event(
      "http.request.failed",
      {
        statusCode: effectiveStatus,
        errorCode,
        ...(errorMessage ? { errorMessage } : {}),
        // Present only for routes that produced a normalized error. This is
        // where `ambiguous`-bucket volume becomes measurable without paging on
        // it — see the field docs in `log-events.ts`.
        ...(webErrorMeta?.origin ? { origin: webErrorMeta.origin } : {}),
        ...(webErrorMeta?.slug ? { slug: webErrorMeta.slug } : {}),
        // Omitted when undeclared rather than defaulted. A row with no `hop`
        // is one nobody has attributed yet, which is not the same claim as
        // "the user's hop" — see the field docs in `log-events.ts`.
        ...(webErrorMeta?.hop ? { hop: webErrorMeta.hop } : {}),
      },
      { error: thrown instanceof Error ? thrown : undefined },
    );
  } else if (effectiveStatus >= 400) {
    // 4xx: a declared client outcome, deliberately NOT `http.request.failed`
    // — but typed anyway. `classifyRuntimeError` checks 401 before every
    // other branch, so an MCP auth incident can arrive here entirely as
    // 401s (measured on the 08-06 route: 2,328 401s next to 4,932 500s),
    // and #3948 moved the largest upstream-auth class to 403. Without
    // code/origin/slug those classes fingerprint as one `route 401` bucket
    // per route and rate spikes are undiagnosable.
    const webErrorMeta =
      c.var.webErrorMeta?.status === effectiveStatus
        ? c.var.webErrorMeta
        : undefined;
    const errorCode = thrown ? classifyError(thrown) : webErrorMeta?.code;
    const rawErrorMessage = thrown
      ? thrown instanceof Error
        ? thrown.message
        : String(thrown)
      : webErrorMeta?.message;
    const errorMessage = rawErrorMessage?.slice(0, 500);
    reqLogger.event("http.request.completed", {
      statusCode: effectiveStatus,
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      ...(webErrorMeta?.origin ? { origin: webErrorMeta.origin } : {}),
      ...(webErrorMeta?.slug ? { slug: webErrorMeta.slug } : {}),
    });
  } else {
    reqLogger.event("http.request.completed", {
      statusCode: effectiveStatus,
    });
  }

  if (thrown) throw thrown;
}
