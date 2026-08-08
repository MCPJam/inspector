/**
 * For the v1 routes that DON'T forward the bearer to Convex.
 *
 * `bearerAuthMiddleware` deliberately lets an unrecognized bearer through
 * unverified: almost every v1 route hands the token to Convex, which verifies
 * it against AuthKit's JWKS before doing anything, so verifying here too would
 * add a JWKS round trip to reach the same answer. The fallthrough is labelled
 * `authMethod: "unverified_passthrough"` precisely because it is an assertion,
 * not a fact.
 *
 * Two v1 routes serve a response WITHOUT ever calling Convex:
 *
 *   GET /agent-ops                        (routes/v1/agent.ts)
 *   GET /harness/:id/builtin-tools        (routes/v1/harness.ts)
 *
 * For those, nothing downstream ever contradicts the assertion — reaching the
 * handler IS the authorization — so `Authorization: Bearer anything` reads
 * them. Both return static metadata rather than customer data, which is why
 * this is a hardening fix and not an incident; but "the bearer gate does not
 * gate" is not a property to leave in place because today's payload is dull.
 *
 * THE RULE: a v1 route that does not forward the bearer to Convex must mount
 * this middleware. It is also recorded in `bearer-auth.ts`, next to the
 * fallthrough that makes it necessary.
 *
 * What passes:
 *  - anything `bearerAuthMiddleware` genuinely established — a validated `sk_`
 *    key, a Slack/Discord service token, a validated guest;
 *  - a raw bearer this middleware verifies here and now against AuthKit;
 *  - ANY caller, when AuthKit is not configured at all.
 *
 * That last one is not a loophole, it is the OSS story. A self-hosted install
 * with no WorkOS has no identity system to protect and no JWKS to verify
 * against; failing closed would break `GET /harness/:id/builtin-tools` for
 * every local user to defend static package metadata from nobody. Only
 * `AuthKitConfigError` — the "this deployment has no WorkOS" signal — takes
 * that branch. A verification FAILURE on a configured deployment is a 401.
 */
import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import {
  AuthKitConfigError,
  verifyAuthKitToken,
} from "../services/authkit-jwt.js";
import { isGuestAllowedV1Request } from "../routes/v1/guest-allowed-paths.js";
import { logger } from "../utils/logger.js";

/** Injectable for tests; production uses the env-derived AuthKit issuers. */
export type RequireVerifiedAuthDeps = {
  verify: typeof verifyAuthKitToken;
};

const defaultDeps: RequireVerifiedAuthDeps = { verify: verifyAuthKitToken };

function unauthorized(c: Context) {
  return c.json(
    {
      code: ErrorCode.UNAUTHORIZED,
      message: "Invalid or expired credentials.",
    },
    401
  );
}

export function requireVerifiedAuth(deps: RequireVerifiedAuthDeps = defaultDeps) {
  return async function requireVerifiedAuthMiddleware(c: Context, next: Next) {
    const authMethod = c.get("authMethod");

    /**
     * A GUEST is admitted only where guests are allowed — checked HERE rather
     * than left to the sibling deny in `routes/v1/index.ts`.
     *
     * That deny does run first today, and it does close guests out of every
     * route this middleware currently fronts. But "correct because of mount
     * order" is not a property that survives: reuse this middleware on another
     * router, move a `v1.use("*")`, or refactor the deny, and a validated guest
     * token reaches a route whose whole point is that it is authenticated-only.
     * Asking the same allowlist the boundary asks costs one predicate and makes
     * the middleware enforce its own admission rule.
     *
     * `guestId` is what identifies a guest, not the `authMethod` label: the
     * label is newer than the guest branch, so trusting only it would be
     * fragile in the other direction.
     */
    const guestId = c.get("guestId");
    if (guestId) {
      return isGuestAllowedV1Request(c.req.method, c.req.path)
        ? next()
        : unauthorized(c);
    }

    // Any other established method. `unverified_passthrough` is excluded
    // deliberately — see the header: it is an assertion, not a verification.
    if (authMethod && authMethod !== "unverified_passthrough") {
      return next();
    }

    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      // Unreachable behind `bearerAuthMiddleware`, which 401s on a missing
      // bearer before this runs. Kept so the middleware is safe to mount
      // anywhere, rather than correct only in one arrangement.
      return unauthorized(c);
    }

    try {
      const session = await deps.verify(token);
      c.set("workosUserId", session.sub);
      return next();
    } catch (error) {
      if (error instanceof AuthKitConfigError) {
        // No WorkOS on this deployment (OSS / self-hosted). See the header.
        return next();
      }
      // `info`, not `warn`: `logger.warn` captures a Sentry MESSAGE on every
      // call, and the volume here is entirely attacker-controlled. An
      // unverified caller does pass THROUGH `guestRateLimitMiddleware` — it
      // just does nothing, because it keys on `guestId` and there is none — so
      // nothing upstream bounds how often this line runs. Credential spraying
      // would turn one rejection into a Sentry event per request and bury real
      // signal. `info` still ships to Axiom, where a spike is queryable and
      // where you would go looking for it anyway.
      logger.info("Rejected unverified bearer on a non-proxying v1 route", {
        event: "auth.require_verified_auth_denied",
        path: c.req.path,
      });
      return unauthorized(c);
    }
  };
}
