/**
 * Hono glue for the v1 public envelope.
 *
 * The pure contract lives in `contract.ts` (shared, framework-agnostic). This
 * module adapts it to Hono `c.json(...)` responses and bridges the Inspector's
 * existing error classification (`mapRuntimeError` + `ErrorCode`) onto the
 * public code union, upgrading MCP auth failures to OAUTH_REQUIRED.
 */
import type { Context } from "hono";
import { isMCPAuthError } from "@mcpjam/sdk";
import { ErrorCode, mapRuntimeError } from "../web/errors.js";
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
  if (safeIsMcpAuthError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: "OAUTH_REQUIRED", message };
  }
  if (isMcpMethodNotFound(error)) {
    const message = error instanceof Error ? error.message : String(error);
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
