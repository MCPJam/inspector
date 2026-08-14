import type { Context } from "hono";
import type { NormalizedError } from "@mcpjam/sdk";
import {
  reportRouteFailure,
  type RouteFailureHop,
  type RouteFailureReport,
} from "./route-error-report.js";
import { getRequestLogger, getSystemLogger } from "./request-logger.js";

/**
 * The classification/emission seam for failures HTTP status cannot see —
 * SSE `{type:"error"}` chunks after 200 headers and JSON-RPC error envelopes
 * over HTTP 200.
 *
 * Why a reporter and not the Hono context: the chat engines
 * (`mcpjam-stream-handler.ts`, `run-harness-turn.ts`) and the JSON-RPC
 * bridge deliberately know nothing about Hono. The route layer, which does
 * hold `c`, constructs a request-scoped reporter and passes exactly one
 * function down; evals/swarm runs (no request context) get the system
 * variant instead, so the engines never grow a transport dependency and no
 * caller can silently lose events.
 *
 * Classification stays entirely inside `reportRouteFailure`: capture
 * decision first (stamps the error so a later `logger.error` cannot
 * double-page), then the free-form Axiom row, then — here — the typed
 * `route.operation.failed` event carrying the EFFECTIVE origin the capture
 * decision was made on.
 */
export type StreamFailureEvent = {
  /** Log line for the free-form row, e.g. "[harness] turn failed". */
  message: string;
  /** The original error. Synthesize `new Error(text)` at status-only sites. */
  error: unknown;
  /** Stable catch-site id — becomes the Sentry tag `route:${source}`. */
  source: string;
  hop: RouteFailureHop;
  transport: "http_stream" | "rpc_envelope";
  /** Pass through when the site already computed it; saves a second pass. */
  normalized?: NormalizedError;
  errorCode?: string;
  rpcMethod?: string;
  /** Extra structured context for the free-form row and Sentry. */
  context?: Record<string, unknown>;
};

export type StreamFailureReporter = (
  event: StreamFailureEvent,
) => RouteFailureReport;

function classify(e: StreamFailureEvent): RouteFailureReport {
  return reportRouteFailure(e.message, e.error, {
    source: e.source,
    hop: e.hop,
    ...(e.normalized ? { normalized: e.normalized } : {}),
    ...(e.context ? { context: e.context } : {}),
  });
}

function toPayload(e: StreamFailureEvent, report: RouteFailureReport) {
  const rawMessage =
    e.error instanceof Error ? e.error.message : String(e.error);
  return {
    transport: e.transport,
    source: e.source,
    hop: e.hop,
    origin: report.origin,
    ...(report.normalized.slug ? { slug: report.normalized.slug } : {}),
    ...(e.errorCode ? { errorCode: e.errorCode } : {}),
    errorMessage: rawMessage.slice(0, 500),
    ...(e.rpcMethod ? { rpcMethod: e.rpcMethod } : {}),
  };
}

export function createRequestStreamFailureReporter(
  c: Context,
  component: string,
): StreamFailureReporter {
  const log = getRequestLogger(c, component);
  return (e) => {
    const report = classify(e);
    log.event("route.operation.failed", toPayload(e, report));
    return report;
  };
}

export function createSystemStreamFailureReporter(
  component: string,
): StreamFailureReporter {
  const log = getSystemLogger(component);
  return (e) => {
    const report = classify(e);
    log.event("route.operation.failed", toPayload(e, report));
    return report;
  };
}

/**
 * At most one typed event per engine invocation. A turn can hit the
 * backend-stream failure site (which returns rather than throws) and then a
 * later step can still throw; both failures deserve classification and a
 * free-form row — capture is deduped by the stamp regardless — but a single
 * turn must not count twice in the operation-failure rate the monitors read.
 */
export function oncePerTurn(
  reporter: StreamFailureReporter,
): StreamFailureReporter {
  let emitted = false;
  return (e) => {
    if (emitted) return classify(e);
    emitted = true;
    return reporter(e);
  };
}
