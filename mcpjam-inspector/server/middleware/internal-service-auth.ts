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
import type { Context, MiddlewareHandler } from "hono";
import {
  INSPECTOR_SERVICE_TOKEN_HEADER,
  getServiceCredential,
  presentedServiceCredentialMatches,
} from "../services/service-credential.js";

// Re-exported for the callers that already import it from here. The one
// definition lives in `services/service-credential.ts`.
export { INSPECTOR_SERVICE_TOKEN_HEADER };

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
  return getServiceCredential();
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
  // Constant-time over SHA-256 digests of both sides (see
  // `constantTimeTokenEquals`): no length branch, no early exit.
  return presentedServiceCredentialMatches(
    c.req.header(INSPECTOR_SERVICE_TOKEN_HEADER),
  );
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
