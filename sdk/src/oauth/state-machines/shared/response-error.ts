import { sanitizeTraceErrorMessage } from "../trace-redaction.js";

/**
 * Cap on the reason text. A failing server can answer with an HTML error page
 * or a multi-megabyte stack dump; the reason is appended to a one-line flow
 * error that also ships to error reporting, so it has to stay a line.
 */
const MAX_REASON_CHARS = 300;

/**
 * Normalize one candidate field into a reason, or `undefined` if it carries no
 * text.
 *
 * Whitespace is collapsed, not just trimmed: a plain-text body is routinely a
 * stack trace or an HTML page, and the reason is appended to a single-line
 * error that renders in a toast and titles an error-report group. A field that
 * is whitespace-only is treated as absent so precedence falls through to a
 * field that says something, and so composing a pair can never emit a dangling
 * `": "`.
 */
function toReason(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, MAX_REASON_CHARS) : undefined;
}

/**
 * Pull the server's own explanation out of a failed response body.
 *
 * A status line alone ("400 Bad Request") names no cause: the reason a server
 * rejected the request — the header it wanted, the param it could not parse —
 * lives in the body. Callers hold that body already; without this it never
 * reaches the flow error, so the failure reads as unexplained on screen and
 * arrives at error reporting as a bare status.
 *
 * Returns `undefined` when the body carries nothing usable, so callers append
 * a reason only when there is one rather than printing an empty suffix.
 */
export function extractResponseErrorReason(body: unknown): string | undefined {
  if (typeof body === "string") {
    return toReason(body);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const data = body as Record<string, unknown>;
  const errorType = toReason(data.error_type);
  const errorDescription = toReason(data.error_description);
  const errorMessage =
    toReason(data.error_message) ?? errorDescription ?? toReason(data.message);
  const errorCode = toReason(data.error);

  if (errorType && errorMessage) {
    return toReason(`${errorType}: ${errorMessage}`);
  }

  if (errorCode && errorDescription) {
    return toReason(`${errorCode}: ${errorDescription}`);
  }

  if (errorCode) {
    return errorCode;
  }

  // JSON-RPC shape: `{ error: { code, message } }`, which is what an MCP
  // server returns when it rejects the authenticated request itself. Reached
  // only when `error` is not a string, so it cannot shadow the OAuth shapes.
  const nestedError = data.error;
  if (
    nestedError &&
    typeof nestedError === "object" &&
    !Array.isArray(nestedError)
  ) {
    const nestedMessage = toReason(
      (nestedError as Record<string, unknown>).message
    );
    if (nestedMessage) {
      return nestedMessage;
    }
  }

  return errorMessage;
}

/**
 * The flow error for a rejected authenticated request — the debugger's last
 * step, where the server under test answers the token it just issued.
 *
 * Status line first so the shape is unchanged, then the server's own reason
 * when the body carries one. Every protocol era ends on that step (older ones
 * with `initialize`, 2026-07-28 with `tools/list`), so they all report it the
 * same way.
 *
 * The reason is redacted here rather than at each display: it is text the
 * server under test chose, and MCPJam is routinely pointed at half-built
 * servers that echo the bearer token back in an error body. This value becomes
 * `state.error`, which is toasted, folded into conformance step results, and
 * reported — the full body stays readable in HTTP history either way.
 */
export function describeAuthenticatedRequestFailure(response: {
  status: number;
  statusText: string;
  body?: unknown;
}): string {
  const reason = extractResponseErrorReason(response.body);
  const safeReason = reason
    ? sanitizeTraceErrorMessage(reason, { maxLength: MAX_REASON_CHARS })
    : undefined;
  return `Authenticated request failed: ${response.status} ${
    response.statusText
  }${safeReason ? `: ${safeReason}` : ""}`;
}
