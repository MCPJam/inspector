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
 *
 * `artifacts` is the one route that is not JSON: it carries one artifact's
 * raw bytes (widget evidence too large to send inline) and answers with the
 * storage id (MJ-006).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Error } from "./envelope.js";

const evalIngest = new Hono();

// The backend enforces its own 5 MiB payload cap (MAX_SDK_EVALS_REQUEST_BYTES);
// this slightly larger guard only keeps a hostile body from buffering
// unbounded in this process before the backend gets to reject it.
const MAX_INGEST_BODY_BYTES = 6 * 1024 * 1024;

// Ingestion batches fan out into widget-blob uploads and several mutations
// backend-side; give them more room than the 15s catalog reads.
const PROXY_TIMEOUT_MS = 60_000;

// An artifact is forwarded to a backend HTTP action, whose request ceiling is
// 20 MiB; the backend applies the per-artifact cap itself. Bounded here as
// the bytes arrive so an oversized body is refused without being held.
const MAX_ARTIFACT_BODY_BYTES = 20 * 1024 * 1024;

const INGEST_SUFFIXES = [
  "capabilities",
  "runs/evaluations",
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
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }

  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_INGEST_BODY_BYTES) {
    return v1Error(
      c,
      "VALIDATION_ERROR",
      "Payload exceeds the eval ingestion size limit",
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
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

for (const suffix of INGEST_SUFFIXES) {
  evalIngest.post(`/projects/:projectId/eval-ingest/${suffix}`, (c) =>
    proxyIngest(c, suffix),
  );
}

/** The request body, or null once it grows past `maxBytes`. */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function proxyArtifact(c: Context): Promise<Response> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }

  const bytes = await readBoundedBody(c.req.raw, MAX_ARTIFACT_BODY_BYTES);
  if (bytes === null) {
    return v1Error(
      c,
      "VALIDATION_ERROR",
      "Artifact exceeds the eval ingestion size limit",
    );
  }

  // Same project rule as the JSON routes, carried as a query parameter
  // because the body is the artifact itself.
  const target = new URL("/v1/evals/ingest/artifacts", convexUrl);
  const projectId = c.req.param("projectId");
  if (projectId && projectId !== "default") {
    target.searchParams.set("projectId", projectId);
  }

  const bearer = await getConvexBearerForRequest(c);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type":
          c.req.header("content-type") || "application/octet-stream",
        authorization: `Bearer ${bearer}`,
      },
      body: bytes,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    // The SDK reporter waits this long before retrying a 429.
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) c.header("Retry-After", retryAfter);
    return c.json(body ?? {}, response.status as never);
  } catch (error) {
    if (isAbortError(error)) {
      return v1Error(c, "TIMEOUT", "Eval ingestion timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

evalIngest.post("/projects/:projectId/eval-ingest/artifacts", proxyArtifact);

export default evalIngest;
