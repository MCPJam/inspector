/**
 * Cap on the reason text. A failing server can answer with an HTML error page
 * or a multi-megabyte stack dump; the reason is appended to a one-line flow
 * error that also ships to error reporting, so it has to stay a line.
 */
const MAX_REASON_CHARS = 300;

function cap(reason: string): string {
  return reason.slice(0, MAX_REASON_CHARS);
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
    const trimmed = body.trim();
    return trimmed ? cap(trimmed) : undefined;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const data = body as Record<string, unknown>;
  const errorType =
    typeof data.error_type === "string" ? data.error_type : undefined;
  const errorMessage =
    typeof data.error_message === "string"
      ? data.error_message
      : typeof data.error_description === "string"
      ? data.error_description
      : typeof data.message === "string"
      ? data.message
      : undefined;

  if (errorType && errorMessage) {
    return cap(`${errorType}: ${errorMessage}`);
  }

  if (
    typeof data.error === "string" &&
    typeof data.error_description === "string"
  ) {
    return cap(`${data.error}: ${data.error_description}`);
  }

  if (typeof data.error === "string") {
    return cap(data.error);
  }

  // JSON-RPC shape: `{ error: { code, message } }`, which is what an MCP
  // server returns when it rejects the authenticated request itself.
  const nestedError = data.error;
  if (
    nestedError &&
    typeof nestedError === "object" &&
    !Array.isArray(nestedError) &&
    typeof (nestedError as Record<string, unknown>).message === "string"
  ) {
    return cap((nestedError as Record<string, unknown>).message as string);
  }

  return errorMessage ? cap(errorMessage) : undefined;
}

/**
 * The flow error for a rejected authenticated request — the debugger's last
 * step, where the server under test answers the token it just issued.
 *
 * Status line first so the shape is unchanged, then the server's own reason
 * when the body carries one. Every protocol era ends on this same step, so
 * they all report it the same way.
 */
export function describeAuthenticatedRequestFailure(response: {
  status: number;
  statusText: string;
  body?: unknown;
}): string {
  const reason = extractResponseErrorReason(response.body);
  return `Authenticated request failed: ${response.status} ${
    response.statusText
  }${reason ? `: ${reason}` : ""}`;
}
