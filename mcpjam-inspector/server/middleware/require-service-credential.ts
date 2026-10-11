/**
 * Route-level gate for HOSTED-ONLY features: answer with the shared
 * hosted-only response (`FEATURE_NOT_SUPPORTED`, `details.reason:
 * "FEATURE_REQUIRES_HOSTED"`) when this process holds no service credential,
 * instead of letting each handler fail its own way deep inside.
 *
 * Gated on the CREDENTIAL, not on `HOSTED_MODE`: what these routes cannot do
 * without is the credential, and a contributor running a non-hosted server
 * with a dev token can still exercise them.
 */
import type { MiddlewareHandler } from "hono";
import { hasServiceCredential } from "../services/service-credential.js";
import { hostedOnlyResponse } from "../routes/web/errors.js";

export function requireServiceCredentialRoute(
  feature: string,
): MiddlewareHandler {
  return async (c, next) => {
    if (!hasServiceCredential()) return hostedOnlyResponse(c, feature);
    await next();
  };
}
