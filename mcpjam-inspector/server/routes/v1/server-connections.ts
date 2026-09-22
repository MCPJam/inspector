/**
 * `/api/v1/server-connections` — the public REST surface for connecting an MCP
 * server to a project.
 *
 * These four routes are thin: they forward the CALLER'S OWN bearer to the
 * backend's public connection functions, which is what makes the flow work
 * identically for a signed-in user, an API key, and a guest. The Inspector adds
 * no authority of its own here — a guest JWT is a registered Convex auth
 * provider, so the backend resolves the same actor either way and does the
 * ownership check itself.
 *
 * `handoffUrl` appears in the CREATE response and nowhere else, because the raw
 * handoff token exists exactly once, in the response that minted it. A status
 * read cannot rebuild it, and that is deliberate: a link a caller could re-fetch
 * at will would be a 60-minute browser credential sitting behind a pollable
 * endpoint.
 */

import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getClientIp } from "../../utils/client-ip.js";
import { serverConnectionPollRateLimitMiddleware } from "../../middleware/server-connection-poll-rate-limit.js";
import { v1Resource } from "./envelope.js";

const serverConnections = new Hono();

const createSchema = z.strictObject({
  url: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
  serverId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  reauthorize: z.boolean().optional(),
});

function convexClient(token: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

/**
 * Map the connection flow's own error codes onto v1 codes.
 *
 * The generic `translateConvexWriteError` is not used here because this flow
 * raises a vocabulary it does not know — RATE_LIMITED, ACTIVE_REQUEST_LIMIT —
 * and its fallbacks would flatten both into a 400,
 * which tells a caller to fix their input when the honest answer is "wait",
 * "finish one of the ones you already started", or "this is not on yet".
 */
const CODE_MAP: Record<string, { status: number; code: ErrorCode }> = {
  REQUEST_NOT_FOUND: { status: 404, code: ErrorCode.NOT_FOUND },
  REQUEST_EXPIRED: { status: 409, code: ErrorCode.CONFLICT },
  INVALID_STATE: { status: 409, code: ErrorCode.CONFLICT },
  ACTIVE_REQUEST_LIMIT: { status: 409, code: ErrorCode.CONFLICT },
  AMBIGUOUS_SERVER: { status: 409, code: ErrorCode.CONFLICT },
  RATE_LIMITED: { status: 429, code: ErrorCode.RATE_LIMITED },
  PROJECT_ACCESS_DENIED: { status: 403, code: ErrorCode.FORBIDDEN },
  FORBIDDEN: { status: 403, code: ErrorCode.FORBIDDEN },
  URL_NOT_ALLOWED: { status: 400, code: ErrorCode.VALIDATION_ERROR },
  UNSUPPORTED_AUTH_METHOD: {
    status: 400,
    code: ErrorCode.FEATURE_NOT_SUPPORTED,
  },
};

function translateConnectionError(error: unknown): WebRouteError {
  const data = (error as { data?: unknown } | null)?.data as
    | {
        code?: unknown;
        message?: unknown;
        candidates?: unknown;
        activeRequests?: unknown;
      }
    | undefined;

  const code = typeof data?.code === "string" ? data.code : null;
  const message =
    typeof data?.message === "string"
      ? data.message
      : "The connection request could not be completed.";

  if (code && CODE_MAP[code]) {
    const mapped = CODE_MAP[code]!;
    // Candidates ride along on the details so an AMBIGUOUS_SERVER refusal is
    // actionable rather than a dead end — the caller is told to re-send with a
    // serverId, and this is how they learn which ones exist.
    //
    // `activeRequests` is the same idea for ACTIVE_REQUEST_LIMIT: the refusal
    // says to finish or cancel one, and these are the ids that makes possible.
    // They are the caller's own open requests.
    const details = {
      code,
      ...(Array.isArray(data?.candidates)
        ? { candidates: data.candidates }
        : {}),
      ...(Array.isArray(data?.activeRequests)
        ? { activeRequests: data.activeRequests }
        : {}),
    };
    return new WebRouteError(mapped.status, mapped.code, message, details);
  }

  if (error instanceof WebRouteError) return error;
  return new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    "The connection request could not be completed."
  );
}

// POST /v1/server-connections — start a connection request.
serverConnections.post("/server-connections", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body"
    );
  }
  const body = parseWithSchema(createSchema, raw);
  const token = await getConvexBearerForRequest(c);

  try {
    const result = await convexClient(token).action(
      "serverConnectionsPublic:createConnection" as never,
      {
        url: body.url,
        projectId: body.projectId,
        serverId: body.serverId,
        name: body.name,
        reauthorize: body.reauthorize,
        sourceSurface: "api",
        // The guest per-IP budget is keyed on this. A caller we cannot place
        // passes the sentinel rather than being exempted, so stripping a
        // forwarded-for header buys a seat in the busiest bucket, not a pass.
        //
        // `getClientIp` rather than a hand-rolled header read: it consults
        // `x-real-ip` (set by the trusted reverse proxy) BEFORE the
        // client-mutable `x-forwarded-for`, so a caller cannot pick their own
        // bucket on a deployment that terminates at Railway rather than
        // Cloudflare. Every other rate-limited route in this server keys on it,
        // and a limiter that disagrees with its neighbours about who the client
        // is bounds a different population than the one it names.
        clientIpKey: getClientIp(c) ?? "_unknown",
      } as never
    );
    return v1Resource(c, result as Record<string, unknown>, 201);
  } catch (error) {
    throw translateConnectionError(error);
  }
});

// GET /v1/server-connections/:requestId — poll one request's status.
//
// Its own budget rather than the shared 60/min guest bucket: this route is
// meant to be polled every few seconds while a person authorizes in a browser,
// and charging that to the general bucket would 429 a guest out of the flow for
// following it correctly.
serverConnections.get(
  "/server-connections/:requestId",
  serverConnectionPollRateLimitMiddleware,
  async (c) => {
    const token = await getConvexBearerForRequest(c);
    try {
      const result = await convexClient(token).query(
        "serverConnectionsPublic:getConnection" as never,
        { connectionRequestId: c.req.param("requestId") } as never
      );
      return v1Resource(c, result as Record<string, unknown>);
    } catch (error) {
      throw translateConnectionError(error);
    }
  }
);

// POST /v1/server-connections/:requestId/cancel
serverConnections.post("/server-connections/:requestId/cancel", async (c) => {
  const token = await getConvexBearerForRequest(c);
  try {
    const result = await convexClient(token).mutation(
      "serverConnectionsPublic:cancelConnection" as never,
      { connectionRequestId: c.req.param("requestId") } as never
    );
    return v1Resource(c, result as Record<string, unknown>);
  } catch (error) {
    throw translateConnectionError(error);
  }
});

// POST /v1/server-connections/:requestId/retry-validation
serverConnections.post(
  "/server-connections/:requestId/retry-validation",
  async (c) => {
    const token = await getConvexBearerForRequest(c);
    try {
      const result = await convexClient(token).mutation(
        "serverConnectionsPublic:retryConnectionValidation" as never,
        { connectionRequestId: c.req.param("requestId") } as never
      );
      return v1Resource(c, result as Record<string, unknown>);
    } catch (error) {
      throw translateConnectionError(error);
    }
  }
);

export default serverConnections;
