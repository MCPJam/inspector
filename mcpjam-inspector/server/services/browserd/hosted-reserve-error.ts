/**
 * A control-plane refusal, with its status preserved.
 *
 * Establishing a hosted browser session can fail for reasons that are not
 * failures at all — the org's plan does not include Computers, the member has
 * started too many machines today, the vendor account is full, the box is
 * still provisioning. Every one of them is something a person can act on, and
 * every one of them arrived at the WebMCP Inspector route as a bare
 * `Error("desktop reserve failed (403): ...")`: no status to branch on, so the
 * route's `instanceof` ladder missed it, answered **500**, and captured a
 * Sentry event. A quota that a user hit on purpose became a page for us and an
 * "unexpected error" for them.
 *
 * The status is the whole point, so it is a field rather than something to be
 * parsed back out of a message. `code` is the control plane's own machine
 * code when it sent one (`billing_limit_reached`, `FEATURE_UNAVAILABLE`, …),
 * carried through so the route can distinguish two refusals that share a
 * status without matching on prose.
 */
export class HostedReserveError extends Error {
  constructor(
    message: string,
    /**
     * The control plane's HTTP status, or one the inspector's own
     * `ensureComputerReady` minted for a condition the wire has no status for
     * (504 poll deadline, 502 provision failure, 499 caller went away, 0 for
     * "not configured / network error").
     */
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HostedReserveError";
  }
}
