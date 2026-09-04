import type { Context, Next } from "hono";
import { ErrorCode, webError } from "../routes/web/errors.js";

/**
 * Close a `/web` mount to guests.
 *
 * `bearerAuthMiddleware` establishes WHO the caller is, and it admits a
 * validated guest JWT — that is deliberate, because most `/web` routes serve
 * guests. `getConvexBearerForRequest` then forwards that guest bearer to Convex
 * verbatim. For a mount whose every endpoint resolves a signed-in-only Convex
 * function, the effect is that the refusal happens two hops away, in the
 * backend's error tracker, rather than here: Sentry CONVEX-19R collected
 * thousands of guest-identity refusals that no request-level check ever saw.
 *
 * Keyed on `guestId`, not the `authMethod` label. `guestId` is what
 * `bearerAuthMiddleware` sets to identify a guest; the label is newer than the
 * guest branch, so trusting only it would be fragile in the other direction.
 * Same reasoning `requireVerifiedAuth` gives for the same choice.
 *
 * 403 + `FEATURE_NOT_SUPPORTED` rather than 401: the request is well-formed and
 * the caller IS authenticated — as a guest. Nothing about retrying with the same
 * credential would help, and `FEATURE_NOT_SUPPORTED` is what
 * `runEphemeralConnection`'s `guestUnsupportedMessage` already answers for the
 * same situation.
 */
export function denyGuests(feature: string) {
  return async function denyGuestsMiddleware(c: Context, next: Next) {
    if (c.get("guestId")) {
      return webError(
        c,
        403,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        `${feature} requires a signed-in account.`,
      );
    }
    return next();
  };
}
