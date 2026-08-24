/**
 * Public v1 conformance-result ingestion — thin proxies over the Convex
 * `/v1/conformance/ingest/*` surface.
 *
 * SDK/CLI runs executed outside the platform (local dev, GitHub Actions)
 * land in the Conformance history. Callers authenticate like any other
 * `/api/v1` route (typically an `sk_` API key); the proxy swaps in the
 * delegated org-scoped JWT and forwards the body verbatim.
 *
 * The `:projectId` path segment declares where results land. The literal
 * `default` resolves to the key org's Default project backend-side.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Error } from "./envelope.js";

const conformanceIngest = new Hono();

const MAX_INGEST_BODY_BYTES = 6 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 60_000;

const INGEST_SUFFIXES = [
  "report",
  "runs/start",
  "runs/reports",
  "runs/heartbeat",
  "runs/finalize",
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
      "Payload exceeds the conformance ingestion size limit"
    );
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
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

  const projectId = c.req.param("projectId");
  if (projectId && projectId !== "default") {
    payload.projectId = projectId;
  } else {
    delete payload.projectId;
  }

  const bearer = await getConvexBearerForRequest(c);
  const target = new URL(`/v1/conformance/ingest/${suffix}`, convexUrl);

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
      return v1Error(c, "TIMEOUT", "Conformance ingestion timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

for (const suffix of INGEST_SUFFIXES) {
  conformanceIngest.post(
    `/projects/:projectId/conformance-ingest/${suffix}`,
    (c) => proxyIngest(c, suffix)
  );
}

export default conformanceIngest;
