/**
 * One-entry-point error describer. Browser-safe.
 *
 * Resolution order:
 *  1. MCPError / MCPAuthError sentinel (by class name + code).
 *  2. Numeric JSON-RPC code (`Error & { code: number }`).
 *  3. Node errno (via `extractNodeErrno`).
 *  4. HTTP status pattern (401 / 403 / 5xx).
 *  5. OAuth response-body shape (prioritized-key extractor).
 *  6. Message-regex fallback (connection-error patterns).
 *  7. `internal/unknown` catch-all.
 *
 * Never throws. Always returns a `NormalizedError`.
 */

import { redactSensitiveValue } from "../redaction.js";
import {
  ERROR_CATALOG,
  type ErrorCatalogEntry,
} from "./catalog.js";
import { extractNodeErrno } from "./node-errno.js";

export type NormalizedError = ErrorCatalogEntry & {
  /**
   * Original error message, redacted for bearer tokens / OAuth secrets /
   * provider keys. Safe to render verbatim in the UI.
   */
  rawMessage: string;
  /**
   * Original numeric or string error code, if the source carried one.
   */
  rawCode?: number | string;
  /**
   * Captured `.cause` chain head — only `name` + `message`, redacted.
   */
  cause?: { name: string; message: string };
};

function redactString(value: string): string {
  const out = redactSensitiveValue(value);
  return typeof out === "string" ? out : String(value);
}

function getErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getNumericCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  // Some upstream errors nest under `.error.code`.
  const nested = (error as { error?: { code?: unknown } }).error;
  if (nested && typeof nested === "object") {
    const nc = (nested as { code?: unknown }).code;
    if (typeof nc === "number" && Number.isFinite(nc)) return nc;
  }
  return undefined;
}

function getStringCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number") return statusCode;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status;
  return undefined;
}

function lookupCatalog(slug: string): ErrorCatalogEntry {
  return ERROR_CATALOG[slug] ?? ERROR_CATALOG["internal/unknown"];
}

function inspectorSentinelSlug(message: string): string | undefined {
  if (/NotYetSupportedInStateless/i.test(message)) {
    return "sdk/not_yet_supported_in_stateless";
  }
  if (/StatelessRequiresHttpTransport/i.test(message)) {
    return "sdk/stateless_requires_http";
  }
  if (/PaginatedToolHeaderDiscoveryUnsupported/i.test(message)) {
    return "sdk/paginated_tool_header_discovery_unsupported";
  }
  return undefined;
}

const JSONRPC_SLUG_BY_CODE: Record<number, string> = {
  [-32700]: "jsonrpc/parse_error",
  [-32600]: "jsonrpc/invalid_request",
  [-32601]: "jsonrpc/method_not_found",
  [-32602]: "jsonrpc/invalid_params",
  [-32603]: "jsonrpc/internal_error",
  [-32000]: "jsonrpc/connection_closed",
  [-32004]: "jsonrpc/unsupported_protocol_version",
  [-32042]: "jsonrpc/url_elicitation_required",
};

/**
 * `-32001` is overloaded: upstream uses it for RequestTimeout, the inspector
 * uses the same numeric code for HeaderMismatch. Disambiguate by message.
 */
function resolveDashThirtyTwoThousandOne(message: string): string {
  if (
    /header[^a-z]*mismatch/i.test(message) ||
    /MCP-Protocol-Version/i.test(message)
  ) {
    return "jsonrpc/header_mismatch";
  }
  return "jsonrpc/request_timeout";
}

function nodeErrnoToSlug(errno: string): string | undefined {
  const upper = errno.toUpperCase();
  switch (upper) {
    case "ECONNREFUSED":
      return "transport/econnrefused";
    case "ECONNRESET":
      return "transport/econnreset";
    case "ETIMEDOUT":
      return "transport/etimedout";
    case "ENOTFOUND":
      return "transport/enotfound";
    case "EAI_AGAIN":
      return "transport/eai_again";
    default:
      if (upper.startsWith("UND_ERR_")) return "transport/undici";
      return undefined;
  }
}

function messageSlug(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (/\bsocket\s+hang\s+up\b/i.test(message)) {
    return "transport/socket_hang_up";
  }
  if (/\bfetch\s+failed\b/i.test(message)) {
    return "transport/fetch_failed";
  }
  if (/\bgetaddrinfo\b/i.test(message)) {
    return "transport/enotfound";
  }
  if (
    /\bconnection\s+(?:refused|reset|closed|timed?\s*out|aborted|error|failed)\b/i.test(
      message,
    ) ||
    /\b(?:failed|unable)\s+to\s+connect\b/i.test(message)
  ) {
    // Map to the closest catalog entry by keyword.
    if (lower.includes("refused")) return "transport/econnrefused";
    if (lower.includes("reset")) return "transport/econnreset";
    if (lower.includes("timed out") || lower.includes("timeout")) {
      return "transport/etimedout";
    }
    if (lower.includes("closed")) return "jsonrpc/connection_closed";
    return "transport/fetch_failed";
  }
  if (/Invalid tool name/i.test(message)) {
    return "provider/invalid_tool_name";
  }
  return undefined;
}

/**
 * Inspect OAuth-style error bodies (either a parsed object or a string
 * containing one). Returns a slug when a recognizable OAuth error code is
 * present. Prioritized-key extractor borrowed from
 * `oauth-conformance/formatter.ts` semantics — kept inline to avoid a
 * cross-module refactor.
 */
function oauthBodySlug(error: unknown): string | undefined {
  const body = pickOauthBody(error);
  if (!body) return undefined;

  const code =
    typeof body.error === "string"
      ? body.error
      : typeof body.error_code === "string"
        ? body.error_code
        : undefined;
  if (!code) return undefined;

  switch (code.toLowerCase()) {
    case "invalid_grant":
      return "oauth/invalid_grant";
    case "invalid_client":
      return "oauth/invalid_client";
    case "invalid_redirect_uri":
    case "redirect_uri_mismatch":
      return "oauth/redirect_mismatch";
    default:
      return undefined;
  }
}

function pickOauthBody(
  error: unknown,
): { error?: unknown; error_code?: unknown; error_description?: unknown } | undefined {
  if (!error || typeof error !== "object") return undefined;
  // Some sources stash the body under `.body` or `.data`.
  const body =
    "body" in error
      ? (error as { body: unknown }).body
      : "data" in error
        ? (error as { data: unknown }).data
        : (error as Record<string, unknown>);
  if (!body || typeof body !== "object") return undefined;
  return body as { error?: unknown; error_code?: unknown };
}

function captureCause(error: unknown): NormalizedError["cause"] {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return undefined;
  const name =
    typeof (cause as { name?: unknown }).name === "string"
      ? ((cause as { name: string }).name)
      : "Error";
  const message =
    typeof (cause as { message?: unknown }).message === "string"
      ? redactString((cause as { message: string }).message)
      : "";
  if (!message) return undefined;
  return { name, message };
}

function classifyAuthError(error: unknown): string | undefined {
  const name = getErrorName(error);
  if (name === "MCPAuthError" || name === "UnauthorizedError") {
    return "auth/http_401";
  }
  const stringCode = getStringCode(error);
  if (stringCode === "AUTH_ERROR") return "auth/http_401";
  return undefined;
}

function classifyHttpStatus(status: number): string | undefined {
  if (status === 401) return "auth/http_401";
  if (status === 403) return "auth/http_403";
  return undefined;
}

function classifyByMessageHttp(message: string): string | undefined {
  if (/\b(?:http|status)[:\s-]*401\b/i.test(message)) return "auth/http_401";
  if (/\b(?:http|status)[:\s-]*403\b/i.test(message)) return "auth/http_403";
  return undefined;
}

/**
 * Resolve a slug for the given error, walking the priority list. Returns
 * `internal/unknown` slug if nothing matches.
 */
function resolveSlug(error: unknown): {
  slug: string;
  rawCode?: number | string;
} {
  const message = getErrorMessage(error);

  // (a) Inspector sentinel sniff first — these are SDK-thrown Errors whose
  // class identity is lost across realm boundaries; match on stable text.
  const sentinel = inspectorSentinelSlug(message);
  if (sentinel) return { slug: sentinel };

  // (b) Auth class detector (MCPAuthError, UnauthorizedError, AUTH_ERROR).
  const authClass = classifyAuthError(error);
  if (authClass) return { slug: authClass };

  // (c) Numeric JSON-RPC code.
  const numericCode = getNumericCode(error);
  if (numericCode !== undefined) {
    if (numericCode === -32001) {
      return { slug: resolveDashThirtyTwoThousandOne(message), rawCode: numericCode };
    }
    const slug = JSONRPC_SLUG_BY_CODE[numericCode];
    if (slug) return { slug, rawCode: numericCode };
    // Numeric code that looks like an HTTP status (StreamableHTTPError etc.).
    const fromHttp = classifyHttpStatus(numericCode);
    if (fromHttp) return { slug: fromHttp, rawCode: numericCode };
  }

  // (d) Node errno via string `.code`.
  const errno = extractNodeErrno(error);
  if (errno) {
    const slug = nodeErrnoToSlug(errno);
    if (slug) return { slug, rawCode: errno };
  }

  // (e) HTTP status field (`statusCode` / `status`).
  const httpStatus = getHttpStatus(error);
  if (httpStatus !== undefined) {
    const slug = classifyHttpStatus(httpStatus);
    if (slug) return { slug, rawCode: httpStatus };
  }

  // (f) OAuth body shape.
  const oauthSlug = oauthBodySlug(error);
  if (oauthSlug) return { slug: oauthSlug };

  // (g) Message-regex fallback. Includes auth-text patterns + transport.
  const fromMessageHttp = classifyByMessageHttp(message);
  if (fromMessageHttp) return { slug: fromMessageHttp };

  // Refresh-failed phrasing.
  if (/refresh\s+token/i.test(message) && /(failed|invalid|expired|revoked)/i.test(message)) {
    return { slug: "auth/oauth_refresh_failed" };
  }
  if (/missing\s+(?:or\s+invalid\s+)?bearer/i.test(message)) {
    return { slug: "auth/missing_bearer" };
  }

  const messageBased = messageSlug(message);
  if (messageBased) return { slug: messageBased };

  if (/well[-_]?known/i.test(message) && /(unreachable|fail|404)/i.test(message)) {
    return { slug: "oauth/well_known_unreachable" };
  }

  return { slug: "internal/unknown" };
}

export function describeError(error: unknown): NormalizedError {
  // Crash-safe: every branch is wrapped so the describer never throws.
  try {
    const rawMessage = redactString(getErrorMessage(error));
    const { slug, rawCode } = resolveSlug(error);
    const entry = lookupCatalog(slug);
    const cause = captureCause(error);
    return {
      ...entry,
      rawMessage,
      ...(rawCode !== undefined ? { rawCode } : {}),
      ...(cause ? { cause } : {}),
    };
  } catch {
    // Fallback path: classification threw (e.g. a getter on the error
    // object exploded). Still redact — otherwise a leaked bearer token
    // in error.message would bypass the normal redaction guarantee.
    return crashFallback(error, "Unknown");
  }
}

/**
 * Build a `NormalizedError` from an explicit catalog slug, wrapping the
 * raw error for `rawMessage` / `cause` capture. Use this when the caller
 * has context the generic `describeError` resolver does not — e.g. a chat
 * route that knows an HTTP 401 is from an LLM provider, not an MCP server,
 * and wants to attach `provider/auth_error` instead of the resolver's
 * `auth/http_401`.
 *
 * Unknown slugs fall back to `internal/unknown` (never throws).
 */
export function describeAsSlug(
  slug: string,
  error?: unknown,
): NormalizedError {
  try {
    const entry = lookupCatalog(slug);
    const rawMessage =
      error !== undefined ? redactString(getErrorMessage(error)) : "";
    const cause = captureCause(error);
    return {
      ...entry,
      rawMessage,
      ...(cause ? { cause } : {}),
    };
  } catch {
    // See note on the describeError fallback — redaction must still run.
    return crashFallback(error, "");
  }
}

/**
 * Shared crash-safe fallback for the two top-level entry points. Pulled
 * out so a single audit point covers both — the prior open-coded version
 * skipped redaction in the catch path, which leaked bearer tokens when
 * classification threw (e.g. a throwing `code` getter on the error).
 *
 * Defensive: the message coercion + redact are themselves wrapped, so
 * even a pathological `error.message` getter cannot escape.
 */
function crashFallback(error: unknown, emptyPlaceholder: string): NormalizedError {
  const fallback = ERROR_CATALOG["internal/unknown"];
  let rawMessage = emptyPlaceholder;
  try {
    const raw =
      error instanceof Error ? error.message : String(error ?? emptyPlaceholder);
    rawMessage = redactString(raw);
  } catch {
    rawMessage = emptyPlaceholder;
  }
  return { ...fallback, rawMessage };
}
