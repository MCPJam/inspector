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
import { withStampedAuthChallenge } from "../../utils/connection-effective-auth.js";
import type { z } from "zod";
import { HOSTED_MODE } from "../../config.js";
import { runEphemeralConnection } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { createHostedRpcLogCollector } from "../web/hosted-rpc-logs.js";
import {
  isLocalRouteFailure,
  projectHostedV1Failure,
} from "../../utils/hosted-route-failure.js";
import { v1OnError } from "./envelope.js";

/**
 * Parse the body as a JSON object (or `{}` when empty), WITHOUT merging path
 * params in — so a `.strict()` schema sees only the caller's own fields and can
 * honestly reject unknown ones.
 *
 * The distinction from `synthesizeServerBody` is the whole point: a schema laid
 * over a synthesized body can never be strict (it would reject the `projectId`
 * this module just injected), which means a route using it silently DROPS
 * anything it does not declare. That is fine for a body whose spec says
 * `additionalProperties: true`, and a lie for one that promises otherwise —
 * a caller who sends a knob the route does not support gets a success and no
 * knob.
 */
export async function readJsonObjectBody(
  c: Context
): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
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
  return parsed as Record<string, unknown>;
}

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
 *
 * Hosted, a failure of the connection or of the operation is answered here
 * rather than by the router's `onError`, through the same account the web
 * twins give (MJ-001): the exchange log is collected to describe it from and
 * is never returned, and a target the egress guard refused is a 400. A failure
 * of this server's own work — `format`, or a step `coreFn` marked with
 * `markLocalRouteFailure` — propagates to `onError` like any other route
 * error. Outside hosted mode every error propagates to `onError` as before.
 */
export async function runV1ServerOp<S extends z.ZodTypeAny, T>(
  c: Context,
  schema: S,
  coreFn: (manager: any, body: z.infer<S>) => Promise<T>,
  format: (c: Context, result: T) => Response | Promise<Response>,
  options?: Pick<
    NonNullable<Parameters<typeof runEphemeralConnection>[4]>,
    "timeoutMs"
  >,
): Promise<Response> {
  const collector = HOSTED_MODE ? createHostedRpcLogCollector(null) : undefined;
  let result: T;
  try {
    const rawBody = await synthesizeServerBody(c);
    result = await runEphemeralConnection(
      c,
      rawBody,
      schema,
      // A failure's sign-in challenge is stamped with the connection's
      // effective auth method here, where the server is known.
      (manager, body) =>
        withStampedAuthChallenge(
          manager,
          typeof (body as { serverId?: unknown })?.serverId === "string"
            ? (body as { serverId: string }).serverId
            : undefined,
          () => coreFn(manager, body),
        ),
      {
      timeoutMs: options?.timeoutMs,
      rpcLogger: collector?.rpcLogger,
      httpLogger: collector?.httpLogger,
    });
  } catch (error) {
    if (!collector || isLocalRouteFailure(error)) throw error;
    return v1OnError(
      error,
      c,
      projectHostedV1Failure(
        error,
        collector.buildEnvelope() as Record<string, unknown>,
      ),
    );
  }
  return await format(c, result);
}
