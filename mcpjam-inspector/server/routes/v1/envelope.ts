/**
 * Hono glue for the v1 public envelope.
 *
 * The pure contract lives in `contract.ts` (shared, framework-agnostic). This
 * module adapts it to Hono `c.json(...)` responses and bridges the Inspector's
 * existing error classification (`mapRuntimeError` + `ErrorCode`) onto the
 * public code union, upgrading MCP auth failures to OAUTH_REQUIRED.
 */
import type { Context } from "hono";
import { describeError, isMCPAuthError } from "@mcpjam/sdk";
import { ErrorCode, mapRuntimeError } from "../web/errors.js";
import { maybeCaptureOriginError } from "../../utils/error-origin-capture.js";
import {
  v1ErrorBody,
  v1Page,
  V1_ERROR_STATUS,
  mapInternalCode,
  type V1ErrorCode,
} from "./contract.js";

/** Canonical error response. */
export function v1Error(
  c: Context,
  code: V1ErrorCode,
  message: string,
  details?: Record<string, unknown>
) {
  // Cast the dynamic numeric status to satisfy Hono's literal StatusCode union
  // (the web routes sidestep this by typing `c` as `any` in `webError`).
  return c.json(
    v1ErrorBody(code, message, details),
    V1_ERROR_STATUS[code] as any
  );
}

/** Single-resource success: the resource object returned directly. */
export function v1Resource(c: Context, resource: unknown, status = 200) {
  return c.json(resource as Record<string, unknown>, status as any);
}

/** Collection success: the canonical { items, nextCursor? } page. */
export function v1PageJson<T>(c: Context, items: T[], nextCursor?: string) {
  return c.json(v1Page(items, nextCursor));
}

/**
 * Map any thrown error onto a public v1 code. MCP auth failures (the upstream
 * server demanding an OAuth grant) become OAUTH_REQUIRED so callers can drive
 * the grant; everything else flows through the Inspector's runtime classifier
 * and the internal->public code map.
 *
 * Hosted authorize/connect is *upstream* of the MCP SDK — it rejects a server
 * that needs OAuth before any SDK call runs, throwing
 * `WebRouteError(UNAUTHORIZED, details: { oauthRequired: true })` (see
 * `routes/web/auth.ts`). The MCP-SDK predicate above can't see those, so we
 * also promote them here. Without this branch, callers can't tell "your bearer
 * is bad" from "this server needs OAuth" — both flatten to UNAUTHORIZED.
 */
export function mapErrorToV1(error: unknown): {
  code: V1ErrorCode;
  message: string;
  details?: Record<string, unknown>;
} {
  // The two branches below return BEFORE `mapRuntimeError`, which is where the
  // v1 chain would otherwise make its capture decision. Classify them here so
  // no path out of this function escapes unclassified — both are non-MCPJam in
  // practice (an upstream server demanding a grant, or not implementing a
  // primitive), so in practice this records the verdict and pages on nothing.
  if (safeIsMcpAuthError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    maybeCaptureOriginError(error, describeError(error), {
      source: "v1.mapErrorToV1",
      extra: { code: "OAUTH_REQUIRED" },
    });
    return { code: "OAUTH_REQUIRED", message };
  }
  if (isMcpMethodNotFound(error)) {
    const message = error instanceof Error ? error.message : String(error);
    maybeCaptureOriginError(error, describeError(error), {
      source: "v1.mapErrorToV1",
      extra: { code: "FEATURE_NOT_SUPPORTED" },
    });
    return { code: "FEATURE_NOT_SUPPORTED", message };
  }
  const routeError = mapRuntimeError(error);
  if (
    routeError.code === ErrorCode.UNAUTHORIZED &&
    routeError.details?.oauthRequired === true
  ) {
    return {
      code: "OAUTH_REQUIRED",
      message: routeError.message,
      details: routeError.details,
    };
  }
  // The upstream server refused the credentials we presented. Mapped HERE
  // rather than in the shared `INTERNAL_TO_V1_CODE` table on purpose:
  // `UPSTREAM_AUTH_FAILED` is an Inspector-internal code that the Convex
  // backend never emits, and that table is a SHARED contract the backend
  // keeps a byte-identical copy of (see ./contract.ts) — pushing an
  // Inspector-only concept into it would make the two surfaces drift for a
  // value one of them can never produce. Without this branch `mapInternalCode`
  // falls through its unknown-code default and answers 500 INTERNAL_ERROR, the
  // exact misreport this classification exists to remove, on the surface the
  // CLI and the MCP worker read.
  //
  // FORBIDDEN, not OAUTH_REQUIRED: a genuine `MCPAuthError` was already
  // promoted to OAUTH_REQUIRED at the top of this function, so what reaches
  // here did NOT identify as an MCP auth failure (a transport error carrying
  // 403, or a message-pattern match) and carries no grant for the caller to
  // drive. 403 also matches the status the hosted `/api/web/*` twin returns
  // for the same throw.
  if (routeError.code === ErrorCode.UPSTREAM_AUTH_FAILED) {
    return {
      code: "FORBIDDEN",
      message: routeError.message,
      details: routeError.details,
    };
  }
  return {
    code: mapInternalCode(routeError.code),
    message: routeError.message,
    details: routeError.details,
  };
}

function safeIsMcpAuthError(error: unknown): boolean {
  try {
    return isMCPAuthError(error);
  } catch {
    return false;
  }
}

/**
 * MCP JSON-RPC "Method not found" (-32601): the target server doesn't
 * implement the requested primitive (e.g. `prompts/get` against a server
 * that never declared the prompts capability). The public contract reserves
 * FEATURE_NOT_SUPPORTED (422) for exactly this; without the branch it falls
 * through the runtime classifier as a 500 INTERNAL_ERROR. Duck-typed on the
 * numeric JSON-RPC code so it matches `McpError` across SDK copies.
 */
const JSONRPC_METHOD_NOT_FOUND = -32601;

function isMcpMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === JSONRPC_METHOD_NOT_FOUND
  );
}

/** Hono onError handler for the v1 router. */
export function v1OnError(error: unknown, c: Context) {
  const { code, message, details } = mapErrorToV1(error);
  return v1Error(c, code, message, details);
}
