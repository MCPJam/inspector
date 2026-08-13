/**
 * Inbound `INSPECTOR_SERVICE_TOKEN` verification.
 *
 * Every other place this credential appears in the Inspector sends it OUTBOUND
 * — `services/identity.ts`, `services/organizations.ts`, and friends attach
 * `x-inspector-service-token` to calls at the backend's `/internal/v1/*`
 * routes. This module is the other direction: the check the Inspector applies
 * when the backend calls IT.
 *
 * It is a deliberate mirror of the backend's `convex/lib/serviceToken.ts`,
 * header-only mode. Same header name, same fail-closed posture, same
 * constant-time compare. The two sides of one credential drifting apart is how
 * a rotation succeeds in one repo and locks out the other.
 *
 * WHY THE REQUEST ID IS NOT AUTHORIZATION. The connection-request id (`scr_…`)
 * travels in MCP tool output and CLI JSON — it is designed to be printable. An
 * endpoint that accepted it as proof of anything would hand every surface that
 * displays a request id the ability to drive that request's state machine.
 * Possession of the service token is the only thing that authorizes these
 * routes; the request id merely names which row is being worked on.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

export const INSPECTOR_SERVICE_TOKEN_HEADER = "x-inspector-service-token";

/**
 * The configured token, trimmed, or null when unset or whitespace-only.
 *
 * The trim is not cosmetic. The presented header is trimmed before comparison,
 * so leaving the configured value untrimmed makes the two sides asymmetric: a
 * deployment whose `INSPECTOR_SERVICE_TOKEN` picked up a trailing newline —
 * ordinary when a secret is pasted into a dashboard or read from a file —
 * rejects every correctly presented token. The failure is safe (it fails
 * closed) but total, and it looks like a credential mismatch rather than a
 * stray byte of whitespace.
 *
 * Whitespace-only counts as unset for the same reason: it cannot be the token
 * anyone meant to configure, and treating it as a real value would compare
 * against something no caller can present.
 *
 * NOTE FOR THE MIRROR: the backend's `convex/lib/serviceToken.ts` has the same
 * asymmetry today (untrimmed config, trimmed header) and should get the same
 * treatment. It is not fixed from here — that file is this module's upstream,
 * and a silent one-sided change is exactly the drift the mirror exists to
 * prevent. Fixing it there only makes both sides more forgiving of a
 * misconfiguration; it never widens who is authorized.
 */
export function getConfiguredInspectorServiceToken(): string | null {
  const token = process.env.INSPECTOR_SERVICE_TOKEN?.trim();
  return token ? token : null;
}

/**
 * Constant-time equality over SHA-256 digests of both sides.
 *
 * Digesting first is not belt-and-braces: `timingSafeEqual` throws on a length
 * mismatch, so a raw comparison has to branch on length before it runs — and
 * that branch leaks the secret's length to anyone who can time it. Two digests
 * are always 32 bytes, so the length check can never fail and there is nothing
 * to branch on. A plain `!==` would be worse still, bailing at the first
 * mismatched byte and leaking the divergence position.
 */
function tokenMatches(presented: string, configured: string): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * True only when the deployment has a token configured AND the request
 * presented a matching one.
 *
 * Fails closed on either side missing. A deployment with no
 * `INSPECTOR_SERVICE_TOKEN` set must refuse these routes rather than treat
 * "unconfigured" as "unguarded" — an Inspector booted without the variable is
 * a misconfiguration, and the safe reading of a misconfiguration is that
 * nobody is authorized.
 *
 * Only the dedicated header is consulted. The backend's `serviceToken.ts`
 * additionally offers a `header-or-bearer` mode for one legacy flow and says
 * new routes must not adopt it; this side does not implement it at all, so it
 * cannot be reached for by accident.
 */
export function isAuthorizedInternalServiceRequest(c: Context): boolean {
  const configured = getConfiguredInspectorServiceToken();
  if (!configured) {
    return false;
  }
  const presented = c.req.header(INSPECTOR_SERVICE_TOKEN_HEADER)?.trim();
  if (!presented) {
    return false;
  }
  return tokenMatches(presented, configured);
}

/**
 * Hono middleware form. 401 with a deliberately uninformative body: a caller
 * who cannot authenticate learns only that it could not, never whether the
 * token was absent, malformed, or simply wrong — and never whether the
 * request id it named exists.
 */
export function internalServiceAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!isAuthorizedInternalServiceRequest(c)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    await next();
  };
}
