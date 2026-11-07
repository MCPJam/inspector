/**
 * Why the server could not get a guest session from its upstream.
 *
 * A self-hosted install relays guest mints to the hosted Inspector, so when
 * that hop fails the 503 is made on the user's machine and its log line never
 * leaves it. These details ride on the 503 body instead, so the browser can put
 * the cause in its error report.
 *
 * The same body goes to any browser on hosted, so only closed values may cross:
 * a reason from this list, an HTTP status, and an undici-style error code. Never
 * an error message (a DNS failure's message names the host), a URL, or the
 * upstream body. Both sides run `sanitizeGuestSessionFailureDetails` — the
 * server before it sends, the client on what it reads.
 */
export const GUEST_SESSION_FAILURE_REASONS = [
  "timeout",
  "network",
  "upstream_status",
  "bad_json",
  "bad_payload",
  // The guest authority could not be resolved from this install's
  // configuration (see `server/utils/guest-authority.ts`).
  "configuration",
] as const;

export type GuestSessionFailureReason =
  (typeof GUEST_SESSION_FAILURE_REASONS)[number];

/**
 * The `code` on a 403 from `POST /api/web/guest-session` when the deployment
 * does not issue guest sessions at all (the backend's non-production lockdown).
 * Unlike a revoked guest, this never clears on retry: the browser stops asking
 * and offers sign-in.
 */
export const GUEST_ACCESS_DISABLED_CODE = "GUEST_ACCESS_DISABLED";

/**
 * Carries the same refusal in a header, so the browser can recognise it from
 * the status line alone when the error body is slow to arrive or unreadable.
 */
export const GUEST_SESSION_REFUSAL_HEADER = "x-mcpjam-guest-refusal";

export type GuestSessionFailureDetails = {
  reason: GuestSessionFailureReason;
  /** The upstream's HTTP status, when it answered with a non-ok response. */
  upstreamStatus?: number;
  /** The network error code, e.g. `ENOTFOUND` or `UND_ERR_CONNECT_TIMEOUT`. */
  networkCode?: string;
};

/**
 * The `code` a failed guest-session bootstrap reports to Sentry. The strict
 * boundary forwards only listed codes (`CODE_LISTS` in
 * `scripts/generate-telemetry-catalogs.mjs`) and turns the code into the issue
 * title and part of its grouping, so every cause gets its own issue and alert.
 * Literal strings only: the catalog reads them from source, not at runtime.
 */
export const GUEST_SESSION_FAILURE_CODES = [
  // No guest error at all: the retries ended without a session.
  "guest_session/exhausted",
  // The browser never got an answer from the Inspector server.
  "guest_session/unreachable",
  // The server answered, but not with a usable session.
  "guest_session/bad_response",
  "guest_session/http_4xx",
  "guest_session/http_5xx",
  // The server's own request to the guest authority failed, by reason...
  "guest_session/timeout",
  "guest_session/network",
  "guest_session/upstream_status",
  "guest_session/bad_json",
  "guest_session/bad_payload",
  "guest_session/configuration",
  // ...and, for a network failure, the code Node gave. The TLS ones are what a
  // network that re-signs HTTPS produces when Node does not trust its root.
  "guest_session/network/SELF_SIGNED_CERT_IN_CHAIN",
  "guest_session/network/UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "guest_session/network/UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "guest_session/network/DEPTH_ZERO_SELF_SIGNED_CERT",
  "guest_session/network/CERT_HAS_EXPIRED",
  "guest_session/network/ERR_TLS_CERT_ALTNAME_INVALID",
  "guest_session/network/ECONNREFUSED",
  "guest_session/network/ECONNRESET",
  "guest_session/network/ENOTFOUND",
  "guest_session/network/EAI_AGAIN",
  "guest_session/network/ETIMEDOUT",
  "guest_session/network/EHOSTUNREACH",
  "guest_session/network/ENETUNREACH",
  "guest_session/network/UND_ERR_CONNECT_TIMEOUT",
  "guest_session/network/UND_ERR_SOCKET",
] as const;

export type GuestSessionFailureCode =
  (typeof GUEST_SESSION_FAILURE_CODES)[number];

function isFailureCode(value: string): value is GuestSessionFailureCode {
  return (GUEST_SESSION_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Name a failed guest-session request. `failure` is undefined when the retries
 * ended with no error to describe; `httpStatus` is undefined when the request
 * never got an answer.
 */
export function guestSessionFailureCode(
  failure:
    | { httpStatus?: number; details?: GuestSessionFailureDetails }
    | undefined,
): GuestSessionFailureCode {
  if (!failure) return "guest_session/exhausted";
  const { httpStatus, details } = failure;
  if (details) {
    const specific = `guest_session/network/${details.networkCode}`;
    if (details.reason === "network" && isFailureCode(specific))
      return specific;
    return `guest_session/${details.reason}`;
  }
  if (httpStatus === undefined) return "guest_session/unreachable";
  if (httpStatus < 400) return "guest_session/bad_response";
  return httpStatus < 500 ? "guest_session/http_4xx" : "guest_session/http_5xx";
}

const NETWORK_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

function isFailureReason(value: unknown): value is GuestSessionFailureReason {
  return (
    typeof value === "string" &&
    (GUEST_SESSION_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Keep only the fields this contract allows, or return `undefined` when there
 * is no valid reason. Unknown keys are dropped rather than passed through.
 */
export function sanitizeGuestSessionFailureDetails(
  raw: unknown,
): GuestSessionFailureDetails | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { reason, upstreamStatus, networkCode } = raw as Record<
    string,
    unknown
  >;
  if (!isFailureReason(reason)) return undefined;

  const details: GuestSessionFailureDetails = { reason };
  if (
    typeof upstreamStatus === "number" &&
    Number.isInteger(upstreamStatus) &&
    upstreamStatus >= 100 &&
    upstreamStatus <= 599
  ) {
    details.upstreamStatus = upstreamStatus;
  }
  if (
    typeof networkCode === "string" &&
    NETWORK_CODE_PATTERN.test(networkCode)
  ) {
    details.networkCode = networkCode;
  }
  return details;
}
