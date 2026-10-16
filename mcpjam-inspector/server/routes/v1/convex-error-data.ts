export type ConvexErrorData = {
  code?: unknown;
  minimumVersion?: unknown;
  docsUrl?: unknown;
  message?: unknown;
  kind?: unknown;
  /** The stable sub-code a coded refusal carries alongside its prose. */
  reason?: unknown;
  /** The gated feature's key, on a `FEATURE_UNAVAILABLE` refusal. */
  feature?: unknown;
};


export function convexErrorData(error: unknown): ConvexErrorData | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as ConvexErrorData;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}


export const CI_OWNED_SUITE_READ_ONLY_CODE = "CI_OWNED_SUITE_READ_ONLY";

export const GATE_WAIVER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "gate_waiver_unscoped_suite",
  "gate_waiver_reason_empty",
  "gate_waiver_reason_too_long",
  "gate_waiver_expiry_not_future",
  "gate_waiver_expiry_too_far",
]);

export interface TranslateConvexWriteErrorOptions {
  /** The noun for not-found copy — "Server", "Project", "Host". */
  resource: string;
  /**
   * Copy for the two cases with no better wording: a structured `VALIDATION`
   * throw that carried no message (400), and the terminal unrecognized-failure
   * branch (500). Keep it neutral about fault — it is the only thing the caller
   * sees in both, and the second one is ours, not theirs.
   */
  fallbackMessage?: string;
  /** Copy for a 404 that may equally be a missing parent or no access. */
  notFoundMessage?: string;
  /** Copy for a 409 when the backend sent none. */
  conflictMessage?: string;
  /**
   * Whether an admin-gate failure may answer 403 (default) or must collapse
   * into the same neutral 404 as everything else.
   *
   * Genuinely per-resource, not a style choice. Environments SURFACE the admin
   * gate: you are already a member, so "requires admin" tells you something
   * actionable and reveals nothing you could not see. Sandbox images HIDE it:
   * their gate also guards shared environments, and there a 403 would confirm
   * the resource exists to somebody who cannot otherwise see it. When in doubt
   * leave it hidden.
   */
  adminFailureIsForbidden?: boolean;
}

import { cleanConvexMessage, preconditionDetails, billingDetails, retryAfterFromResetsAt, retryAfterFromMs } from "./convex-error-details.js";
