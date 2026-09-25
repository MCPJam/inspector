import { Hono } from "hono";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { passthroughRateLimitMiddleware } from "../../middleware/passthrough-rate-limit.js";
import { revokeSessionWithAcknowledgment } from "../../services/auth-session-revocation.js";
import { getRequestLogger } from "../../utils/request-logger.js";

/**
 * `/api/web/auth-session/*` — the Inspector client's sign-out hook.
 *
 * `POST /revoke` revokes the WorkOS AuthKit session its own bearer belongs to,
 * so access tokens already issued for that session stop working the moment
 * the user signs out, instead of when they expire. The client calls it with
 * the token it is about to discard, just before WorkOS's `signOut()`.
 *
 * In order (MJ-011): this process refuses the session at once, then the
 * backend is asked for a durable record of the revocation, and only its
 * acknowledgment is reported as `{ revoked: true }`. A timeout or failure is
 * reported as `status: "pending"` — retries continue in the background — or
 * `"failed"`, never as revoked. Other replicas, and this one after a restart,
 * learn of the revocation from the backend's feed, not from this process.
 *
 * Same-origin on purpose: the client sends this as a `keepalive` request so it
 * survives the navigation `signOut()` starts, and a same-origin request needs
 * no CORS preflight to do that. Only the caller's own session can be revoked —
 * the backend reads the session id from the verified token, never from the
 * request — so there is nothing here to authorize beyond the bearer.
 *
 * Always answers 200 with what happened: the caller is a sign-out that has
 * already moved on and has no use for an error.
 */
const authSession = new Hono();

// `sessionAuthMiddleware` bypasses `/api/web/*`, so this router brings its own.
// The limiter runs after the bearer label is set: every accepted request here
// costs a Convex round trip, so the AuthKit callers this route serves get the
// same per-credential budget as `/api/v1`.
authSession.use("*", bearerAuthMiddleware, passthroughRateLimitMiddleware);

/** The labels under which a signed-in AuthKit bearer reaches a handler. */
const AUTHKIT_BEARER_METHODS: ReadonlySet<string> = new Set([
  "authkit_jwt",
  "unverified_passthrough",
]);

authSession.post("/revoke", async (c) => {
  const authMethod = c.get("authMethod");
  // Guests, API keys and service credentials are not AuthKit sessions and have
  // lifecycles of their own; there is nothing for this route to revoke.
  if (
    typeof authMethod !== "string" ||
    !AUTHKIT_BEARER_METHODS.has(authMethod)
  ) {
    return c.json({ revoked: false, reason: "not_a_session" });
  }

  const token = (c.req.header("authorization") ?? "").slice("Bearer ".length);
  const result = await revokeSessionWithAcknowledgment(token, {
    // Only a session id the gateway VERIFIED is refused ahead of the backend's
    // answer; anything else waits for the acknowledgment.
    verifiedSid:
      authMethod === "authkit_jwt" ? c.get("workosSessionId") : undefined,
  });
  if (!result.revoked && "status" in result) {
    getRequestLogger(c, "routes.web.auth-session").event(
      "auth.session.revoke_incomplete",
      { reason: result.reason, status: result.status },
    );
  }
  return c.json(result);
});

export default authSession;
