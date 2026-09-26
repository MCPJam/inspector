/**
 * Public v1 model leases — how an SDK eval running OUTSIDE the platform uses
 * MCPJam-hosted inference on the organization's credits.
 *
 * `@mcpjam/sdk` in a customer's CI has no MCPJam session, only an `sk_` API
 * key. It cannot call the backend's `/web/harness/model-broker/*` routes
 * directly (those take a Convex-verifiable identity), and it must not be handed
 * the gateway key. So it asks HERE for a short-lived, narrowly-scoped lease and
 * then calls the backend's model proxy with it.
 *
 * The lease is strictly narrower than the credential used to get it: one
 * organization, one project, one model, one proxy host, ~30 minutes, a per-lease
 * spend and call cap, and revocable by `runId`. Everything that decides those —
 * the spend precheck, the project resolution, the model allowlist — happens
 * backend-side; this is a thin proxy that swaps the `sk_` key for the delegated
 * org-scoped JWT, exactly as `eval-ingest.ts` does for results.
 *
 * Guest-denied by default (no `GUEST_ALLOWED_V1_RULES` entry): every lease this
 * mints can spend hosted-model credits.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { backendFailureText } from "../../utils/backend-failure-text.js";
import { v1Error } from "./envelope.js";
import type { V1ErrorCode } from "./contract.js";

const modelLeases = new Hono();

// Minting is one signature plus a handful of indexed reads — far short of the
// ingest routes' fan-out, so it gets the catalog reads' deadline rather than
// theirs.
const PROXY_TIMEOUT_MS = 15_000;

/**
 * The broker routes answer `{ok: false, error, code?, retryAfter?}`, not v1
 * envelopes — they were built for the inspector server, which reads statuses.
 * A public caller gets the canonical `{code, message}` instead, so this maps
 * the status rather than passing the body through the way `eval-ingest` can.
 */
const BROKER_STATUS_TO_V1: Record<number, V1ErrorCode> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

function convexUrlOrThrow(): string {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  return convexUrl;
}

async function readJsonObject(
  c: Context,
): Promise<Record<string, unknown> | Response> {
  const raw = await c.req.text();
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    // `null`, numbers, strings and arrays are valid JSON but not valid bodies,
    // and reading fields off them below would throw — turning a client error
    // into a 500.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return v1Error(c, "VALIDATION_ERROR", "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return v1Error(c, "VALIDATION_ERROR", "Invalid JSON body");
  }
}

/** POST one broker route with the delegated JWT, and translate its answer. */
async function callBroker(
  c: Context,
  suffix: "start" | "revoke",
  payload: Record<string, unknown>,
): Promise<{ body: Record<string, unknown> } | Response> {
  const convexUrl = convexUrlOrThrow();
  const bearer = await getConvexBearerForRequest(c);
  const target = new URL(`/web/harness/model-broker/${suffix}`, convexUrl);

  // The deadline covers the whole exchange: `fetch` resolves on headers, so
  // clearing the timer there would leave a stalled body free to hang
  // `response.json()` indefinitely.
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
    const body = ((await response.json().catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >;
    if (response.ok && body.ok === true) return { body };

    const code =
      BROKER_STATUS_TO_V1[response.status] ??
      (response.status >= 500 ? "SERVER_UNREACHABLE" : "INTERNAL_ERROR");
    const message = backendFailureText({
      source: "model-leases",
      status: response.status,
      detail: body.error,
      fallback: "Could not complete the model lease operation",
    });
    // `retryAfter` is seconds, and the spec documents `Retry-After` on every
    // 429 — pass it through rather than promising a header we never send.
    const retryAfter =
      typeof body.retryAfter === "number" && Number.isFinite(body.retryAfter)
        ? { "Retry-After": String(Math.max(0, Math.ceil(body.retryAfter))) }
        : undefined;
    return v1Error(c, code, message, undefined, retryAfter);
  } catch (error) {
    if (isAbortError(error)) {
      return v1Error(c, "TIMEOUT", "Model lease operation timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

modelLeases.post("/projects/:projectId/model-leases", async (c) => {
  const payload = await readJsonObject(c);
  if (payload instanceof Response) return payload;

  const model = payload.model;
  if (typeof model !== "string" || !model.trim()) {
    return v1Error(c, "VALIDATION_ERROR", "model is required");
  }
  const runId = payload.runId;
  if (runId !== undefined && (typeof runId !== "string" || !runId.trim())) {
    return v1Error(c, "VALIDATION_ERROR", "runId must be a non-empty string");
  }
  const maxOutputTokens = payload.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== "number" ||
      !Number.isFinite(maxOutputTokens) ||
      maxOutputTokens <= 0)
  ) {
    return v1Error(
      c,
      "VALIDATION_ERROR",
      "maxOutputTokens must be a positive number",
    );
  }

  // `default` is the zero-config alias: omit projectId so the backend resolves
  // the key org's Default project. Anything else is forwarded and validated
  // (org scope + membership) backend-side — including an id the caller
  // smuggled into the body, which the path segment overrides so the URL is
  // always the single source of truth. Same rule as `eval-ingest`, so a lease
  // and the results it produces always land in the same project.
  const projectId = c.req.param("projectId");
  const result = await callBroker(c, "start", {
    delivery: "sdk-direct",
    modelId: model.trim(),
    ...(typeof runId === "string" ? { runId: runId.trim() } : {}),
    ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}),
    ...(projectId && projectId !== "default" ? { projectId } : {}),
  });
  if (result instanceof Response) return result;

  // Named fields rather than the backend body verbatim: `delivery` is an
  // internal enum and the response shape should not drift with it.
  return c.json({
    lease: result.body.lease,
    protocol: result.body.protocol,
    proxyBaseUrl: result.body.proxyBaseUrl,
    expiresAt: result.body.expiresAt,
    runId: result.body.runId,
    model: model.trim(),
  });
});

modelLeases.post("/projects/:projectId/model-leases/revoke", async (c) => {
  const payload = await readJsonObject(c);
  if (payload instanceof Response) return payload;

  const runId = payload.runId;
  if (typeof runId !== "string" || !runId.trim()) {
    return v1Error(c, "VALIDATION_ERROR", "runId is required");
  }
  const projectId = c.req.param("projectId");
  const result = await callBroker(c, "revoke", {
    runId: runId.trim(),
    delivery: "sdk-direct",
    ...(projectId && projectId !== "default" ? { projectId } : {}),
  });
  if (result instanceof Response) return result;

  return c.json({ ok: true, revoked: result.body.revoked ?? 0 });
});

export default modelLeases;
