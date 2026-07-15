/**
 * MCPJam Public API — v1 contract (shared source of truth).
 *
 * Framework-agnostic: NO Hono, Convex, or Node imports, and no runtime
 * dependencies, so every public-API surface can import it cheaply (the same
 * discipline as `@mcpjam/sdk/host-config/internal`). It defines the wire
 * contract — the error-code union, the code -> HTTP-status map, the
 * internal -> public code mapping, and the envelope/pagination builders.
 *
 * Consumers:
 *   - the Inspector Hono gateway (`mcpjam-inspector/server/routes/v1`) imports
 *     this and adapts it to `c.json(...)` in its `envelope.ts`.
 *   - the Convex backend (`mcpjam-backend/convex/publicApi`) will consume this
 *     once its pinned `@mcpjam/sdk` version includes the subpath; until then it
 *     keeps a byte-identical local copy, cross-checked by golden fixtures.
 *
 * Envelope rules:
 *   - success (single resource) -> the resource object directly
 *   - success (collection)      -> { items, nextCursor? }   (cursor-based)
 *   - error                     -> { code, message, details? }  + HTTP status
 *
 * Framework-specific response helpers (Hono `c.json`, platform `Response`)
 * intentionally live with each consumer, not here.
 */

/**
 * Canonical v1 public error-code union.
 *
 * Reconciliation note: the Inspector Node already ships
 * UNAUTHORIZED/FORBIDDEN/NOT_FOUND/VALIDATION_ERROR/RATE_LIMITED/
 * FEATURE_NOT_SUPPORTED/SERVER_UNREACHABLE/TIMEOUT/INTERNAL_ERROR (see
 * routes/web/errors.ts `ErrorCode`). The public union adopts those verbatim and
 * adds OAUTH_REQUIRED so callers (our MCP worker, CLI, agents) can distinguish
 * "this server needs an OAuth grant" from a generic 401. Draft-only codes
 * UPSTREAM_ERROR/TOOL_TIMEOUT are NOT public; they collapse to
 * SERVER_UNREACHABLE/TIMEOUT at the boundary (see INTERNAL_TO_V1_CODE). Adding
 * codes is backward-compatible; removing or repurposing one is breaking.
 */
export const V1_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "FEATURE_NOT_SUPPORTED",
  "SERVER_UNREACHABLE",
  "TIMEOUT",
  "OAUTH_REQUIRED",
  "INTERNAL_ERROR",
] as const;

export type V1ErrorCode = (typeof V1_ERROR_CODES)[number];

export function isV1ErrorCode(value: unknown): value is V1ErrorCode {
  return (
    typeof value === "string" &&
    (V1_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Canonical error body. `details` is an opaque, JSON-serializable bag. */
export interface V1ErrorBody {
  code: V1ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Canonical collection envelope. Cursor is opaque to the caller. */
export interface V1Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Canonical code -> HTTP status mapping. */
export const V1_ERROR_STATUS: Record<V1ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  FEATURE_NOT_SUPPORTED: 422,
  SERVER_UNREACHABLE: 502,
  TIMEOUT: 504,
  OAUTH_REQUIRED: 401,
  INTERNAL_ERROR: 500,
};

/**
 * Internal/draft code -> public v1 code. Used at the surface boundary to map
 * whatever an internal handler threw (Inspector `ErrorCode`) onto the public
 * union. The 9 shipped Inspector codes map to themselves; the draft-only codes
 * collapse onto their canonical equivalents.
 */
export const INTERNAL_TO_V1_CODE: Record<string, V1ErrorCode> = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_SUPPORTED: "FEATURE_NOT_SUPPORTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UPSTREAM_ERROR: "SERVER_UNREACHABLE",
  OAUTH_REQUIRED: "OAUTH_REQUIRED",
  TOOL_TIMEOUT: "TIMEOUT",
};

export function mapInternalCode(code: string | undefined | null): V1ErrorCode {
  if (code && Object.prototype.hasOwnProperty.call(INTERNAL_TO_V1_CODE, code)) {
    return INTERNAL_TO_V1_CODE[code];
  }
  return "INTERNAL_ERROR";
}

/** Build a canonical error body (drops an empty `details` bag). */
export function v1ErrorBody(
  code: V1ErrorCode,
  message: string,
  details?: Record<string, unknown>
): V1ErrorBody {
  return {
    code,
    message,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

/** Build a canonical collection body (omits `nextCursor` when absent). */
export function v1Page<T>(items: T[], nextCursor?: string): V1Page<T> {
  return nextCursor ? { items, nextCursor } : { items };
}

/**
 * Connection/timeout error classification, shared across public-API surfaces so
 * they bucket raw runtime failures the same way. Mirrors the Inspector
 * `mapRuntimeError` heuristics.
 */
const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /\beconn[a-z]*/i,
  /\bconnection\s+(?:refused|reset|closed|timed?\s*out|aborted|error|failed)\b/i,
  /\b(?:failed|unable)\s+to\s+connect\b/i,
  /\bfetch\s+failed\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bgetaddrinfo\b/i,
];

export function classifyRuntimeError(error: unknown): {
  code: V1ErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { code: "TIMEOUT", message };
  }
  if (CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: "SERVER_UNREACHABLE", message };
  }
  return { code: "INTERNAL_ERROR", message };
}
