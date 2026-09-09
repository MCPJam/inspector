import { sanitizeTraceErrorMessage } from "../trace-redaction.js";

/**
 * Cap on the reason text. A failing server can answer with an HTML error page
 * or a multi-megabyte stack dump; the reason is appended to a one-line flow
 * error that also ships to error reporting, so it has to stay a line.
 *
 * Applied by the redactor rather than here — see
 * {@link describeAuthenticatedRequestFailure}.
 */
const MAX_REASON_CHARS = 300;

const AUTHENTICATED_REQUEST_FAILURE_PREFIX = "Authenticated request failed";

/**
 * Whether a debugger step error is the server under test rejecting the
 * authenticated MCP request.
 *
 * The debug proxy reports its own failures separately. This prefix is only
 * produced after that proxy successfully returns the target server's HTTP
 * response, so consumers can keep the failure visible without filing it as an
 * MCPJam defect.
 */
export function isAuthenticatedRequestFailure(error: string): boolean {
  return error.startsWith(`${AUTHENTICATED_REQUEST_FAILURE_PREFIX}: `);
}

/**
 * Take one candidate field as a reason, or `undefined` if it carries no text.
 *
 * A whitespace-only field counts as absent, so precedence falls through to a
 * field that says something and composing a pair can never emit a dangling
 * `": "`.
 *
 * Trim only — no scan of the value, and no cap. Both belong downstream:
 *
 * - Whitespace is collapsed after redaction, on a string already cut to
 *   {@link MAX_REASON_CHARS}. A body is server-controlled and can be
 *   megabytes; collapsing here would scan and copy all of it, on a path
 *   `trace.ts` re-runs for every projection.
 * - `sanitizeTraceErrorMessage` closes an unterminated JSON value or URL
 *   userinfo only when it is the one that cut the text, so a cap applied first
 *   hides the cut from it and strands the raw prefix of a credential whose
 *   closing delimiter fell just past the cap. It reads the whole string,
 *   bounding its own scan at `MAX_SCANNED`.
 */
function toReason(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Collapse a redacted, already-bounded error onto one line.
 *
 * A step error renders as a line — in a toast, in a trace step, as the title of
 * an error-report group — and the text behind it is a response body, routinely
 * a stack trace or an HTML page.
 *
 * Only ever after redaction and capping, never before. Collapsing shortens the
 * text, so a message that crosses back under `MAX_SCANNED` on the way in reads
 * as untruncated to `sanitizeTraceErrorMessage`, which then skips the guards
 * that close a credential its own cut left unterminated.
 */
export function toSingleLine(message: string): string {
  return message.replace(/\s+/g, " ").trim();
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
 * a reason only when there is one rather than printing an empty suffix. The
 * result is normalized but neither capped nor redacted: every caller passes it
 * through `sanitizeTraceErrorMessage`, which owns both.
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

/** A response a step can fail on — the fields every failure message reads. */
interface FailedResponse {
  status: number;
  statusText: string;
  body?: unknown;
}

/**
 * `"<what failed>: <status line>"`, plus the server's own reason when its body
 * carries one.
 *
 * The status line always leads, so a body that explains nothing still names the
 * code. Never interpolate a body field into the message directly: `error` is a
 * string only when the server follows RFC 6749, and an MCP server rejecting the
 * request answers with the JSON-RPC `{ error: { code, message } }` shape
 * instead — which renders as `[object Object]` and buries every distinct
 * failure in one error-report group. {@link extractResponseErrorReason} knows
 * both shapes.
 *
 * The reason is redacted here rather than at each display: it is text the
 * server under test chose, and MCPJam is routinely pointed at half-built
 * servers that echo the bearer token back in an error body. The result becomes
 * `state.error`, which is toasted, folded into conformance step results, and
 * reported — the full body stays readable in HTTP history either way.
 *
 * The redactor receives the whole reason and caps it, rather than being handed
 * a pre-cut one: it closes an unterminated JSON value or URL userinfo only when
 * it made the cut itself, so cutting first would strand the raw head of a
 * credential whose closing delimiter sat just past the cap. Its own scan window
 * (`MAX_SCANNED`) bounds the work, so a megabyte body costs one slice.
 *
 * Whitespace is collapsed last, on that capped output: the message renders in a
 * toast and titles an error-report group, so a stack trace or an HTML page must
 * not carry its newlines in — and collapsing before the cap would scan the
 * whole body to do it.
 *
 * `statusText` goes through the same pipeline as the reason, for the same
 * reason: it is the reason-phrase the server under test wrote, not a value we
 * derived. RFC 9112 confines it to one short line of visible characters, but a
 * server that ignores that — or a proxy that synthesizes the field from
 * something else — would otherwise put unredacted text straight into the
 * message. The status code beside it is the part that is always trustworthy.
 *
 * An empty phrase is dropped rather than printed, so a response with no reason
 * phrase reads `"...: 502"` instead of trailing a bare space. `statusText` is
 * typed as required, but the value crosses a proxy boundary before it gets
 * here, so a missing one degrades to that same code-only form rather than
 * throwing inside the redactor.
 */
function describeResponseFailure(
  label: string,
  response: FailedResponse
): string {
  const safeStatusText = toSingleLine(
    sanitizeTraceErrorMessage(response.statusText ?? "", {
      maxLength: MAX_REASON_CHARS,
    })
  );
  const reason = extractResponseErrorReason(response.body);
  const safeReason = reason
    ? toSingleLine(
        sanitizeTraceErrorMessage(reason, { maxLength: MAX_REASON_CHARS })
      )
    : undefined;
  return `${label}: ${response.status}${
    safeStatusText ? ` ${safeStatusText}` : ""
  }${safeReason ? `: ${safeReason}` : ""}`;
}

/**
 * The flow error for a rejected authenticated request — the debugger's last
 * step, where the server under test answers the token it just issued.
 *
 * Every protocol era ends on that step (older ones with `initialize`,
 * 2026-07-28 with `tools/list`), so they all report it the same way.
 */
export function describeAuthenticatedRequestFailure(
  response: FailedResponse
): string {
  return describeResponseFailure(
    AUTHENTICATED_REQUEST_FAILURE_PREFIX,
    response
  );
}

/**
 * The flow error for a rejected token exchange — the authorization server
 * refusing to trade the code (or the client credentials) for a token.
 *
 * Shared by every debug state machine and by the conformance
 * client-credentials strategy, which all previously hand-rolled the message
 * from `body.error` and so reported `[object Object] - Unknown error` whenever
 * the endpoint answered in a non-RFC-6749 shape.
 */
export function describeTokenRequestFailure(response: FailedResponse): string {
  return describeResponseFailure("Token request failed", response);
}
