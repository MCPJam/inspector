/**
 * Shared adapter for v1 single-server live operations.
 *
 * The public contract is resource-oriented and project-scoped
 * (`/projects/:projectId/servers/:serverId/<op>`), but the existing web schemas
 * and the connection layer expect `projectId`/`serverId` in the request body.
 * `synthesizeServerBody` bridges the two: it merges the path params over the
 * public JSON body, producing a body the web Zod schemas accept. `runV1ServerOp`
 * then reuses the extracted `runEphemeralConnection` (same authorize -> connect
 * -> run pipeline as `/api/web/*`) and lets the caller format the result into
 * the public envelope. Errors propagate to the v1 router's `onError`.
 */
import type { Context } from "hono";
import type { z } from "zod";
import { runEphemeralConnection } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";

/**
 * Build the web-schema body from the v1 path params + the public JSON body.
 * Path params win, so a caller can't smuggle a different projectId/serverId in
 * the body than the URL they were authorized against.
 */
export async function synthesizeServerBody(
  c: Context
): Promise<Record<string, unknown>> {
  const projectId = c.req.param("projectId");
  const serverId = c.req.param("serverId");
  let body: Record<string, unknown> = {};
  const text = await c.req.text();
  if (text && text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Match /api/web/* (readJsonBody): a non-empty body that isn't valid
      // JSON is a request error, not a silently-empty body — otherwise a
      // caller's malformed `{ uri }` would surface as a confusing
      // missing-field error instead of "invalid JSON".
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid JSON body"
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be a JSON object"
      );
    }
    body = parsed as Record<string, unknown>;
  }
  // Path params win over the body so a caller can't smuggle a different
  // projectId/serverId than the URL they were authorized against.
  return { ...body, projectId, serverId };
}

/**
 * Run a single-server live op end-to-end: synthesize the body, authorize +
 * connect via the shared connection layer, run `coreFn`, then format the result
 * with `format`. The core helpers (`listTools`, `validateServerCore`, ...) are
 * the exact ones the `/api/web/*` routes use — no forked handler logic.
 */
export async function runV1ServerOp<S extends z.ZodTypeAny, T>(
  c: Context,
  schema: S,
  coreFn: (manager: any, body: z.infer<S>) => Promise<T>,
  format: (c: Context, result: T) => Response | Promise<Response>,
  options?: { timeoutMs?: number }
): Promise<Response> {
  const rawBody = await synthesizeServerBody(c);
  const result = await runEphemeralConnection(c, rawBody, schema, coreFn, {
    timeoutMs: options?.timeoutMs,
  });
  return await format(c, result);
}
