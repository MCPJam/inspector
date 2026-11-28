import type { GuestSessionFailureDetails } from "@/shared/guest-session-failure";

export type GuestSessionRefusalReason =
  "rate_limited" | "guest_access_disabled";

export class GuestSessionRequestError extends Error {
  /**
   * The HTTP status when the server answered with a non-ok response. Absent
   * for a network error or an unreadable body — that absence is the signal
   * that the request never got a real answer from the server.
   */
  readonly status?: number;
  /**
   * Why the server could not get a session from ITS upstream, from the 503
   * body. On a self-hosted install that 503 is made on the user's machine, so
   * this is the only place the cause shows up.
   */
  readonly upstreamFailure?: GuestSessionFailureDetails;
  constructor(
    message: string,
    status?: number,
    upstreamFailure?: GuestSessionFailureDetails,
    // What `fetch` threw when there is no status. Kept as `cause` so a report
    // can name the browser's own error class instead of this wrapper's.
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GuestSessionRequestError";
    this.status = status;
    this.upstreamFailure = upstreamFailure;
  }
}

/**
 * The server named the cookie's guest as revoked or suspended. Keeps its
 * parent's name, so error reports group as before; a mint still retries,
 * since a new guest replaces the revoked one.
 */
export class GuestSessionRevokedError extends GuestSessionRequestError {}

/** The server refused to create a guest. Not transient: do not retry. */
export class GuestSessionRefusedError extends GuestSessionRequestError {
  readonly retryAfterMs: number;
  readonly reason: GuestSessionRefusalReason;
  constructor(retryAfterMs: number, reason: GuestSessionRefusalReason) {
    super("Couldn't start a guest session. Sign in to continue.");
    this.name = "GuestSessionRefusedError";
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
  }
}

/** A refusal that a retry will not change, unlike a rate limit or an outage. */
export function isFinalGuestRefusal(error: unknown): boolean {
  return (
    error instanceof GuestSessionRevokedError ||
    (error instanceof GuestSessionRefusedError &&
      error.reason === "guest_access_disabled")
  );
}
