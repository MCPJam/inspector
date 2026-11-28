import type { Context, MiddlewareHandler } from "hono";
import { getRequestLogger } from "../../utils/request-logger.js";
import { assertBearerToken, ErrorCode, WebRouteError } from "./errors.js";

/**
 * Mint, list and revoke of the caller's OWN API keys through the backend's
 * `/web/api-keys` routes, which hold the WorkOS key and decide. The Inspector
 * forwards the caller's own session bearer, names no user itself, and answers
 * with the backend's status and body, which are the ones the in-Inspector
 * routes in `api-keys.ts` give.
 *
 * Off unless `MCPJAM_API_KEYS_VIA_BACKEND=true`. Even then, a backend without
 * the routes (Convex answers an unknown path with its own plain-text 404)
 * leaves the request to the in-Inspector path, so either side can deploy
 * first. That path, and the WorkOS key it needs, stay until the old paths are
 * deleted, so turning the switch off is the rollback.
 */
export const API_KEYS_VIA_BACKEND_ENV = "MCPJAM_API_KEYS_VIA_BACKEND";

const API_KEYS_PATH = "/web/api-keys";
/** Covers a mint's WorkOS create, binding and cleanup delete. */
const BACKEND_TIMEOUT_MS = 60_000;
const UNREACHABLE =
  "Could not reach MCPJam to manage API keys. Check your API keys before trying again.";

export type OwnApiKeyRequest =
  | { method: "POST"; body: Record<string, unknown> }
  | { method: "GET" }
  | { method: "DELETE"; keyId: string };

export type BackendApiKeysAnswer =
  /** The backend's success status and body, to return as they are. */
  | { kind: "answered"; status: number; body: unknown }
  /** DELETE only: the key is not among the caller's own. */
  | { kind: "not_own_key" }
  /** The switch is off or the backend lacks the routes. */
  | { kind: "in_inspector" };

const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

/**
 * What Convex answers for a path it has no route for. Only this means the
 * backend lacks the routes; any other 404 may come from something in between
 * after a mint went through.
 */
const CONVEX_NO_ROUTE = /^No HttpAction routed for \//;

/**
 * Success statuses to restore, by request: `handleRoute` answers 200, and a
 * backend that answered otherwise (a mint's 201) keeps its own.
 */
const answeredStatus = new WeakMap<Request, number>();

/** The backend's body for the route to return, with its status kept. */
export function backendAnswer(
  c: Context,
  answer: Extract<BackendApiKeysAnswer, { kind: "answered" }>,
): unknown {
  answeredStatus.set(c.req.raw, answer.status);
  return answer.body;
}

/** Restores a backend answer's status after the route has answered 200. */
export const keepBackendStatus: MiddlewareHandler = async (c, next) => {
  await next();
  const status = answeredStatus.get(c.req.raw);
  if (status !== undefined && status !== 200 && c.res.status === 200) {
    c.res = new Response(c.res.body, { status, headers: c.res.headers });
  }
};

/** The backend's `{ code, message, details? }`, or null for any other body. */
function readRefusal(body: unknown): {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
} | null {
  const { code, message, details } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return {
    code: ERROR_CODES.has(code)
      ? (code as ErrorCode)
      : ErrorCode.INTERNAL_ERROR,
    message,
    ...(details && typeof details === "object"
      ? { details: details as Record<string, unknown> }
      : {}),
  };
}

/**
 * Sends one own-key request to the backend. Throws the backend's refusal as a
 * `WebRouteError`. Only a backend without the routes hands the request back
 * to the in-Inspector path; a failed or garbled answer does not, since a mint
 * the backend may have finished must not run twice.
 */
export async function forwardOwnApiKeyRequest(
  c: Context,
  request: OwnApiKeyRequest,
): Promise<BackendApiKeysAnswer> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (process.env[API_KEYS_VIA_BACKEND_ENV] !== "true" || !convexUrl) {
    return { kind: "in_inspector" };
  }
  const bearer = assertBearerToken(c);
  const unavailable = (fields: {
    statusCode?: number;
    errorMessage?: string;
  }) => {
    getRequestLogger(c, "routes.web.api-keys").event(
      "apikey.backend.unavailable",
      { method: request.method, ...fields },
    );
    return new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, UNREACHABLE);
  };
  const query =
    request.method === "DELETE"
      ? `?${new URLSearchParams({ keyId: request.keyId })}`
      : "";
  let response: Response;
  try {
    response = await fetch(`${convexUrl}${API_KEYS_PATH}${query}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        ...(request.method === "POST"
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        request.method === "POST" ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (error) {
    throw unavailable({
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw unavailable({
      statusCode: response.status,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON: Convex's own answer for an unknown path, or a proxy's page.
    body = undefined;
  }
  if (response.ok && body !== undefined) {
    return { kind: "answered", status: response.status, body };
  }
  const refusal = readRefusal(body);
  if (!refusal) {
    if (response.status === 404 && CONVEX_NO_ROUTE.test(text)) {
      return { kind: "in_inspector" };
    }
    throw unavailable({ statusCode: response.status });
  }
  if (
    request.method === "DELETE" &&
    response.status === 404 &&
    refusal.code === ErrorCode.NOT_FOUND
  ) {
    return { kind: "not_own_key" };
  }
  throw new WebRouteError(
    response.status,
    refusal.code,
    refusal.message,
    refusal.details,
  );
}
