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
  "provisioning",
] as const;

export type GuestSessionFailureReason =
  (typeof GUEST_SESSION_FAILURE_REASONS)[number];

export type GuestSessionFailureDetails = {
  reason: GuestSessionFailureReason;
  /** The upstream's HTTP status, when it answered with a non-ok response. */
  upstreamStatus?: number;
  /** The network error code, e.g. `ENOTFOUND` or `UND_ERR_CONNECT_TIMEOUT`. */
  networkCode?: string;
};

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
