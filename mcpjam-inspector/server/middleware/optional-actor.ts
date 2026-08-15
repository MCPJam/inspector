/**
 * Resolve WHO is asking, when there is anybody, and never refuse if there is not.
 *
 * The handoff claim needs a signed-in user's id so the backend can enforce that
 * a link belonging to an account is claimed by that account — a link that leaked
 * into a channel must not let a different signed-in user adopt the request. But
 * the same route must stay open to a signed-out visitor and to a guest, because
 * being signed out is the normal case: the link arrives in a terminal or a chat
 * client, and the person opening it may have no MCPJam session at all.
 *
 * `bearerAuthMiddleware` cannot do this job. It 401s the moment an
 * `Authorization` header is missing, which is precisely the case that must
 * succeed. Reading `c.get("mcpjamUserId")` without mounting anything does not
 * work either — that is what the route did before, and nothing ever set it, so
 * the ownership check the backend performs was being handed `undefined` on every
 * single claim.
 *
 * WHY VERIFICATION, NOT THE PASSTHROUGH LABEL. `bearerAuthMiddleware` lets an
 * unrecognized bearer through unverified (`authMethod: "unverified_passthrough"`)
 * because its routes forward the token to Convex, which checks it. This route
 * does NOT forward it: the Inspector ASSERTS the actor to the backend over the
 * service channel, and the backend believes it. An asserted identity would
 * therefore be an identity anyone could claim — send `Authorization: Bearer
 * <anything>` alongside a stolen handoff link and the ownership check would
 * approve it. So the token is verified here, against AuthKit, before its subject
 * becomes an actor.
 *
 * FAILING TO RESOLVE IS SAFE, AND DELIBERATELY QUIET. A malformed, expired, or
 * unknown token yields NO actor rather than a 401. The backend fails closed on
 * the other side — an account-owned request with no matching actor is a 403 with
 * a message that says so — so the worst outcome of a bad token is the same
 * refusal the user would get for someone else's link. Answering 401 here instead
 * would break the guest flow for anyone whose browser happens to send a stale
 * token.
 */

import type { Context, Next } from "hono";
import {
  AuthKitConfigError,
  verifyAuthKitToken,
} from "../services/authkit-jwt.js";
import { resolveUserByExternalId } from "../services/identity.js";
import { logger } from "../utils/logger.js";

export type OptionalActorDeps = {
  verify: typeof verifyAuthKitToken;
  resolveUser: typeof resolveUserByExternalId;
};

const defaultDeps: OptionalActorDeps = {
  verify: verifyAuthKitToken,
  resolveUser: resolveUserByExternalId,
};

export function resolveOptionalActor(deps: OptionalActorDeps = defaultDeps) {
  return async function optionalActorMiddleware(
    c: Context,
    next: Next
  ): Promise<Response | void> {
    // Already established upstream (a validated `sk_` key sets this). Don't
    // spend a JWKS round trip re-deciding something that is already known.
    if (c.get("mcpjamUserId")) {
      return next();
    }

    const header = c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      return next();
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return next();
    }

    try {
      const session = await deps.verify(token);
      c.set("workosUserId", session.sub);
      const user = await deps.resolveUser(session.sub);
      if (user) {
        c.set("mcpjamUserId", user._id);
      }
    } catch (error) {
      if (error instanceof AuthKitConfigError) {
        // No WorkOS on this deployment (OSS / self-hosted). There are no
        // accounts to own a request, so there is no actor to resolve and
        // nothing to log.
        return next();
      }
      // `info`, not `warn`: `logger.warn` raises a Sentry message, and the
      // volume here is attacker-controllable — this route is deliberately
      // reachable without credentials. A spike is still queryable in Axiom,
      // which is where anyone would look for it.
      logger.info("Could not resolve an optional actor from the bearer", {
        event: "auth.optional_actor_unresolved",
        path: c.req.path,
      });
    }

    return next();
  };
}
