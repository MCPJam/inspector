/**
 * Public v1 eval-result ingestion — thin proxies over the Convex
 * `/v1/evals/ingest/*` surface.
 *
 * This is how SDK eval runs executed OUTSIDE the platform (local dev, CI)
 * land in the Evals dashboard now that project API keys (`mcpjam_…`) and
 * their `/sdk/v1/evals/*` surface are retired. Callers authenticate like any
 * other `/api/v1` route (typically an `sk_` API key); the proxy swaps in the
 * delegated org-scoped JWT and forwards the body verbatim, so the backend's
 * fail-closed org scoping applies to every write.
 *
 * The `:projectId` path segment declares where results land. The literal
 * `default` resolves to the key org's Default project backend-side — the
 * zero-config CI case. Status and body are passed through verbatim: the
 * backend emits the legacy `{ok: true, …}` success shapes (which the SDK
 * reporter parses) and the canonical v1 `{code, message}` errors.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { v1Error } from "./envelope.js";

const evalIngest = new Hono();

// The backend enforces its own 5 MiB payload cap (MAX_SDK_EVALS_REQUEST_BYTES);
// this slightly larger guard only keeps a hostile body from buffering
// unbounded in this process before the backend gets to reject it.
const MAX_INGEST_BODY_BYTES = 6 * 1024 * 1024;

// Ingestion batches fan out into widget-blob uploads and several mutations
// backend-side; give them more room than the 15s catalog reads.
const PROXY_TIMEOUT_MS = 60_000;

const INGEST_SUFFIXES = [
  "report",
  "runs/start",
  "runs/iterations",
  "runs/finalize",
  "artifacts/upload-url",
] as const;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

async function proxyIngest(c: Context, suffix: string): Promise<Response> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_INGEST_BODY_BYTES) {
    return v1Error(
      c,
      "VALIDATION_ERROR",
      "Payload exceeds the eval ingestion size limit"
    );
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    // `null`, numbers, strings, and arrays are valid JSON but not valid
    // ingest bodies — and mutating projectId on them below would throw
    // (strict mode), turning a client error into a 500.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return v1Error(c, "VALIDATION_ERROR", "JSON body must be an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return v1Error(c, "VALIDATION_ERROR", "Invalid JSON body");
  }

  // `default` is the zero-config alias: omit projectId so the backend
  // resolves the org's Default project. Anything else is forwarded and
  // validated (org scope + membership) backend-side — including ids the
  // caller smuggled into the body, which the path segment overwrites so
  // the URL is always the single source of truth.
  const projectId = c.req.param("projectId");
  if (projectId && projectId !== "default") {
    payload.projectId = projectId;
  } else {
    delete payload.projectId;
  }

  const bearer = await getConvexBearerForRequest(c);
  const target = new URL(`/v1/evals/ingest/${suffix}`, convexUrl);

  // The abort deadline covers the whole exchange: `fetch` resolves on
  // headers, so clearing the timer there would leave a stalled response
  // body free to hang `response.json()` indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    return c.json(body ?? {}, response.status as never);
  } catch (error) {
    if (isAbortError(error)) {
      return v1Error(c, "TIMEOUT", "Eval ingestion timed out");
    }
    // The hop that just failed was to MCPJam's OWN Convex deployment, not to
    // anything a caller controls, so an unrecognized failure here is ours by
    // default — the exact case `mcpjam_internal` documents. Without the
    // declaration a `fetch` failure classifies `transport/fetch_failed` →
    // `ambiguous` and never reaches the MCPJam-fault monitor, which is why 44
    // opaque 500s sat on this route in 72h with nothing watching them.
    //
    // Reported here rather than at `v1OnError` because only this frame knows
    // whose hop it was; the shared handler sees every v1 route at once and
    // would have to guess. `reportRouteFailure` returns the effective origin,
    // which rides on the rethrown error so the envelope reports the same
    // verdict Sentry was paged on — `mapRuntimeError` never downgrades an
    // origin that is already set.
    const report = reportRouteFailure(
      "[v1.eval-ingest] convex ingest proxy failed",
      error,
      {
        source: "v1.eval-ingest",
        hop: "mcpjam_internal",
        context: { suffix },
      },
    );
    // Status stays 500/INTERNAL_ERROR, deliberately. 502 SERVER_UNREACHABLE
    // reads as "the USER's target MCP server is down" everywhere else in this
    // codebase — it is the basis of the 502 triage doctrine (judge a spike by
    // server-id concentration) — and borrowing it for OUR Convex would corrupt
    // that. Reclassifying a route's status also has form here: #3948 moved
    // upstream auth rejections 500->403 and silently blinded the spike
    // monitor's `maxStatus >= 500` clause. The bug being fixed is missing
    // ATTRIBUTION, not a wrong status, so the status does not move.
    const routeError = new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      `Eval ingestion upstream failed: ${report.normalized.rawMessage}`,
      undefined,
      report.normalized,
    );
    routeError.origin = report.origin;
    throw routeError;
  } finally {
    clearTimeout(timer);
  }
}

for (const suffix of INGEST_SUFFIXES) {
  evalIngest.post(`/projects/:projectId/eval-ingest/${suffix}`, (c) =>
    proxyIngest(c, suffix)
  );
}

export default evalIngest;
