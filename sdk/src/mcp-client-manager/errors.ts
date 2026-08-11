/**
 * Custom error classes for MCP SDK
 */

/**
 * Base error class for all MCP SDK errors
 */
export class MCPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "MCPError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Authentication error - thrown for 401, token expired, invalid token, etc.
 */
export class MCPAuthError extends MCPError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    options?: { cause?: unknown }
  ) {
    super(message, "AUTH_ERROR", options);
    this.name = "MCPAuthError";
  }
}

/**
 * Tasks wire mismatch — a tasks operation was requested against a server whose
 * negotiated protocol version / advertised capabilities resolve to a different
 * wire (or to no tasks wire at all). Nothing is sent when this throws.
 */
export class MCPTasksWireError extends MCPError {
  constructor(
    message: string,
    public readonly wire: string,
    options?: { cause?: unknown }
  ) {
    super(message, "TASKS_WIRE_ERROR", options);
    this.name = "MCPTasksWireError";
  }
}

/** Type guard for {@link MCPTasksWireError}. */
export function isMCPTasksWireError(
  error: unknown
): error is MCPTasksWireError {
  return error instanceof MCPTasksWireError;
}

/**
 * Type guard to check if an error is an MCPAuthError
 */
export function isMCPAuthError(error: unknown): error is MCPAuthError {
  return error instanceof MCPAuthError;
}

/**
 * Type guard for errors with a numeric code property (like StreamableHTTPError, SseError)
 */
function hasNumericCode(error: unknown): error is Error & { code: number } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  );
}

function getNumericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  if (statusCode !== undefined) {
    return statusCode;
  }

  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  if (status !== undefined) {
    return status;
  }

  const code =
    "code" in error && typeof error.code === "number"
      ? error.code
      : undefined;
  return code;
}

/**
 * The `SdkErrorCode` value the upstream client raises when AUTOMATIC version
 * negotiation cannot establish an era (no modern overlap, or the
 * `server/discover` probe itself failed). Matched by its stable string VALUE
 * so recognition survives minification / cross-bundle boundaries without
 * importing the runtime `SdkErrorCode` enum.
 */
const ERA_NEGOTIATION_FAILED_CODE = "ERA_NEGOTIATION_FAILED";

/** True when `error` is an `SdkError(EraNegotiationFailed)` wrapper. */
function isEraNegotiationError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === ERA_NEGOTIATION_FAILED_CODE
  );
}

/**
 * Unwrap the underlying transport error carried by an auto-negotiation probe
 * failure.
 *
 * With auto activation an UNCONFIGURED connection probes with
 * `server/discover`; when that probe hits an OAuth-gated endpoint the upstream
 * client raises `SdkError(EraNegotiationFailed)` carrying the real transport
 * error (e.g. `UnauthorizedError`) at `error.data.cause`. 401 recovery and
 * connection telemetry must see the real 401 through that wrapper rather than
 * treating the whole connect as an opaque negotiation failure — otherwise an
 * unconfigured connect to a protected server would surface a generic
 * negotiation error instead of triggering OAuth.
 *
 * Returns the innermost non-wrapper error; returns the input UNCHANGED when it
 * is not an era-negotiation wrapper — a non-wrapper transport error (e.g. a
 * bare `UnauthorizedError` from an explicit legacy pin, where no probe and
 * therefore no wrapper ever occurs) passes through byte-identically.
 */
export function unwrapEraNegotiationCause(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isEraNegotiationError(current) && !seen.has(current)) {
    seen.add(current);
    const data = (current as { data?: unknown }).data;
    const dataCause =
      data && typeof data === "object"
        ? (data as { cause?: unknown }).cause
        : undefined;
    const next = dataCause ?? (current as { cause?: unknown }).cause;
    if (next === undefined || next === current) {
      break;
    }
    current = next;
  }
  return current;
}

/**
 * Classify a connection failure into the short, string `failureClass` reported
 * on a negotiation-outcome telemetry event.
 *
 * Prefers the error's `name`, then its `code`, then the string form of a string
 * cause, falling back to `"unknown"`. A transport `code` is frequently numeric
 * at runtime (e.g. `401` / `403`), so it is normalized with `String(...)` — a
 * bare cast would let a number escape into the `failureClass?: string` public
 * contract. The caller is expected to pass the UNWRAPPED cause (see
 * {@link unwrapEraNegotiationCause}) so the real transport class is reported
 * rather than the opaque era-negotiation wrapper.
 */
export function classifyNegotiationFailureClass(cause: unknown): string {
  const name =
    cause && typeof cause === "object"
      ? (cause as { name?: unknown }).name
      : undefined;
  if (typeof name === "string") {
    return name;
  }
  const code =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown }).code
      : undefined;
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }
  if (typeof cause === "string") {
    return cause;
  }
  return "unknown";
}

/**
 * Strictly detects HTTP 401 authorization failures.
 *
 * Unlike isAuthError, this intentionally does not treat 403 or generic
 * auth-looking messages as refreshable. OAuth refresh can repair an expired or
 * rejected access token; it cannot repair insufficient scope.
 *
 * Sees through an `SdkError(EraNegotiationFailed)` wrapper so an auto-probe
 * 401 (unconfigured connect to an OAuth-gated server) is recognized — see
 * {@link unwrapEraNegotiationCause}.
 */
export function isUnauthorized401(error: unknown): boolean {
  const target = unwrapEraNegotiationCause(error);
  const numericStatus = getNumericStatus(target);
  if (numericStatus !== undefined) {
    return numericStatus === 401;
  }

  if (!(target instanceof Error)) {
    return false;
  }

  if (target.name === "UnauthorizedError") {
    return true;
  }

  const message = target.message.toLowerCase();
  return /\b(?:http|status)[:\s-]*401\b/i.test(message);
}

/** The `WWW-Authenticate` step-up challenge fields surfaced to a caller. */
export type InsufficientScopeChallenge = {
  requiredScope?: string;
  resourceMetadataUrl?: string;
  errorDescription?: string;
};

/**
 * Walk an error's `.cause` chain, returning the first non-`undefined` result
 * from `visit`.
 *
 * Shared by the two SEP-2350 recognizers below so the traversal — including
 * its cycle guard — exists once. They used to be separate walks in two
 * repositories, which is how they drifted: only one of them knew that
 * `resourceMetadataUrl` arrives as a `URL` object rather than a string.
 */
function findInCauseChain<T>(
  error: unknown,
  visit: (node: any) => T | undefined,
): T | undefined {
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const result = visit(current);
    if (result !== undefined) return result;
    current = current.cause;
  }
  return undefined;
}

/**
 * Recognize the real `InsufficientScopeError` class, and nothing else.
 *
 * By its brand (`constructor.mcpBrand`, which survives minification and
 * cross-realm) or `.name` — never by duck-typing a `requiredScope` field. An
 * unrelated error that happens to carry that field must not be serialized to a
 * client as an OAuth step-up challenge, because that would trigger a spurious
 * re-authorization.
 */
function isInsufficientScopeNode(node: any): boolean {
  return (
    node?.constructor?.mcpBrand === "mcp.InsufficientScopeError" ||
    node?.name === "InsufficientScopeError"
  );
}

/**
 * Strictly detects an upstream `InsufficientScopeError` (SEP-2350 runtime scope
 * step-up) anywhere in the error / cause chain.
 *
 * Used to keep a connect-time 403 `insufficient_scope` from being swallowed /
 * downgraded by the Streamable→SSE transport fallback, which would strip the
 * challenge fields.
 *
 * Deliberately NOT `extractInsufficientScopeChallenge(error) !== undefined`:
 * this returns true for a branded error carrying no challenge fields at all,
 * because the transport-fallback protection cares that the class was seen, not
 * that it was actionable.
 */
export function isInsufficientScopeError(error: unknown): boolean {
  return (
    findInCauseChain(error, (node) =>
      isInsufficientScopeNode(node) ? true : undefined,
    ) === true
  );
}

/**
 * Recognize an upstream `InsufficientScopeError` (SEP-2350) anywhere in the
 * error / cause chain and return its `WWW-Authenticate` challenge fields.
 *
 * A runtime `403 insufficient_scope` from a live MCP request surfaces as this
 * transport-layer error (the transport is constructed with
 * `onInsufficientScope: "throw"`, so it never attempts a doomed server-side
 * interactive re-authorization). Returning the challenge lets a client drive
 * the union-scope step-up re-authorization.
 *
 * The fields originate from the resource server's header, so treat them as
 * UNTRUSTED when rendering.
 *
 * Returns `undefined` when no challenge field is present — a bare name match
 * carries nothing actionable — and keeps walking in that case, so a branded but
 * empty wrapper does not hide a populated challenge deeper in the chain.
 */
export function extractInsufficientScopeChallenge(
  error: unknown,
): InsufficientScopeChallenge | undefined {
  return findInCauseChain(error, (node) => {
    if (!isInsufficientScopeNode(node)) return undefined;

    const requiredScope =
      typeof node.requiredScope === "string" ? node.requiredScope : undefined;
    // `resourceMetadataUrl` is a `URL` OBJECT at runtime — the transport builds
    // it with `new URL(...)` when parsing the `WWW-Authenticate` header — even
    // though older callers passed a string. A bare `typeof === "string"` check
    // silently DROPS the real production value.
    const rawResourceMetadataUrl = node.resourceMetadataUrl;
    const resourceMetadataUrl =
      typeof rawResourceMetadataUrl === "string"
        ? rawResourceMetadataUrl
        : rawResourceMetadataUrl instanceof URL ||
            (rawResourceMetadataUrl &&
              typeof rawResourceMetadataUrl === "object" &&
              typeof rawResourceMetadataUrl.href === "string")
          ? String(rawResourceMetadataUrl)
          : undefined;
    const errorDescription =
      typeof node.errorDescription === "string"
        ? node.errorDescription
        : undefined;

    if (requiredScope || resourceMetadataUrl || errorDescription) {
      return { requiredScope, resourceMetadataUrl, errorDescription };
    }
    return undefined;
  });
}

/**
 * Checks if an error is an authentication-related error.
 * Detects auth errors by:
 * 1. Error class name (UnauthorizedError from MCP SDK)
 * 2. HTTP status codes (401, 403) from transport errors
 * 3. Common auth-related patterns in error messages (case-insensitive)
 */
export function isAuthError(error: unknown): {
  isAuth: boolean;
  statusCode?: number;
} {
  // See through an auto-negotiation probe wrapper so a wrapped 401/403 is
  // still classified as an auth error (identity for non-wrapped errors).
  error = unwrapEraNegotiationCause(error);
  if (!(error instanceof Error)) {
    return { isAuth: false };
  }

  // Check for MCP client's UnauthorizedError by class name
  // (We check by name to avoid importing the runtime class here)
  if (error.name === "UnauthorizedError") {
    return { isAuth: true, statusCode: 401 };
  }

  // Check for our own MCPAuthError by name
  if (error.name === "MCPAuthError") {
    const statusCode =
      "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    return { isAuth: true, statusCode };
  }

  // Check for transport errors with HTTP status codes (StreamableHTTPError, SseError)
  if (hasNumericCode(error)) {
    const code = error.code;
    if (code === 401 || code === 403) {
      return { isAuth: true, statusCode: code };
    }
  }

  // Fall back to message pattern matching (case-insensitive)
  const message = error.message.toLowerCase();
  const authPatterns = [
    "unauthorized",
    "invalid_token",
    "invalid token",
    "token expired",
    "token has expired",
    "access denied",
    "authentication failed",
    "authentication required",
    "not authenticated",
    "forbidden",
  ];

  if (authPatterns.some((pattern) => message.includes(pattern))) {
    return { isAuth: true };
  }

  // Check for HTTP status codes in error messages (e.g., "HTTP 401" or "status: 401")
  const statusMatch = message.match(/\b(status[:\s]*)?401\b|\bhttp\s*401\b/i);
  if (statusMatch) {
    return { isAuth: true, statusCode: 401 };
  }

  const forbiddenMatch = message.match(
    /\b(status[:\s]*)?403\b|\bhttp\s*403\b/i
  );
  if (forbiddenMatch) {
    return { isAuth: true, statusCode: 403 };
  }

  return { isAuth: false };
}
