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

    // Already established upstream. `guestId` is checked separately because a
    // guest is identified by that, not by the label — and the label is newer
    // than the guest branch, so trusting only the label would be fragile.
    if (
      (authMethod && authMethod !== "unverified_passthrough") ||
      c.get("guestId")
    ) {
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
      logger.warn("Rejected unverified bearer on a non-proxying v1 route", {
        event: "auth.require_verified_auth_denied",
        path: c.req.path,
      });
      return unauthorized(c);
    }
  };
}
