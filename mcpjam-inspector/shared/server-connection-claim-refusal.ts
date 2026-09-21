/**
 * Why a handoff claim was refused, in the one vocabulary the page acts on.
 *
 * Shared because the two ends of this fact are in different runtimes: the web
 * route translates the backend's error code into a `reason`, and the handoff
 * page picks a call to action from it. A private copy on either side is a
 * refusal that silently stops rendering its button the first time one string
 * is edited.
 *
 * THE REFUSAL IS NOT THE END OF THE LINK. Neither reason consumes the
 * single-use handoff token — the backend checks who is claiming before it
 * claims anything — so both branches tell the user to open the same link again
 * once they have signed in or switched accounts. Copy that promised otherwise
 * would be wrong, and copy that omits it strands people on a link that still
 * works.
 */

/** The backend's `SIGN_IN_REQUIRED` / `ACCOUNT_MISMATCH` codes, as the page
 * sees them. Kebab-case to match the `reason` fields the XAA routes already
 * put on web error envelopes. */
export type ClaimRefusalReason = "sign-in-required" | "account-mismatch";

/**
 * Map a backend error code onto a reason, or `undefined` when it is not one of
 * the claim refusals.
 *
 * `undefined` is the RIGHT answer for an unrecognized code, including the bare
 * `FORBIDDEN` a backend that predates the split still returns. The page falls
 * back to rendering the backend's prose, which is what it did before any of
 * this existed. Guessing a reason instead would show a signed-out visitor the
 * switch-accounts flow — the precise wrong turn this whole change exists to
 * remove.
 *
 * A `switch` and not an object lookup: the argument is a string off a JSON
 * body, and an object literal answers `constructor` and `toString` with
 * inherited members rather than with `undefined`.
 */
export function claimRefusalReason(
  backendCode: string | undefined
): ClaimRefusalReason | undefined {
  switch (backendCode) {
    case "SIGN_IN_REQUIRED":
      return "sign-in-required";
    case "ACCOUNT_MISMATCH":
      return "account-mismatch";
    default:
      return undefined;
  }
}

/** The shape `details` carries on a refused claim's web error envelope. */
export interface ClaimRefusalDetails {
  reason: ClaimRefusalReason;
  /** Masked email of the account that owns the link, when the backend knew
   * one — `m•••@mcpjam.com`. Absent for a guest owner or an unset address. */
  ownerHint?: string;
}

/**
 * Read the refusal off a web error envelope's `details`, if it is one.
 *
 * Defensive about its input because it parses a JSON body: a field that is
 * present but the wrong type must produce "not a refusal" rather than a page
 * that renders `undefined` at the user.
 */
export function readClaimRefusal(
  details: unknown
): ClaimRefusalDetails | null {
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  const reason = record.reason;
  if (reason !== "sign-in-required" && reason !== "account-mismatch") {
    return null;
  }
  const ownerHint = record.ownerHint;
  return {
    reason,
    ...(typeof ownerHint === "string" && ownerHint ? { ownerHint } : {}),
  };
}
