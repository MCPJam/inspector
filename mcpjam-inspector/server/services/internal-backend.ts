/**
 * Shared plumbing for the backend's service-token-gated `/internal/v1/*`
 * routes (see mcpjam-backend `convex/http.ts`). Inspector authenticates to
 * them with the service credential via the `x-inspector-service-token`
 * header; `CONVEX_HTTP_URL` is the `.convex.site` HTTP-actions origin those
 * routes are mounted on.
 */
import { requireServiceCredential } from "./service-credential.js";

/**
 * The backend origin and the service credential, or a throw.
 *
 * A missing credential throws `ServiceCredentialUnavailableError` (the normal
 * state of a self-hosted build, answered as "hosted-only" by the route
 * mapper); a missing `CONVEX_HTTP_URL` is a plain config error. `feature` is
 * the human name the hosted-only answer uses.
 */
export function getInternalBackendConfig(
  feature = "This feature",
): {
  convexUrl: string;
  serviceToken: string;
} {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  const serviceToken = requireServiceCredential(feature);
  return { convexUrl, serviceToken };
}

/**
 * Distinguish an entity-level 404 (the backend route ran and reported the
 * entity missing, body `{ ok: false, error: <expectedError> }`) from a 404
 * produced by Convex routing itself when the path doesn't exist — e.g. the
 * backend route isn't deployed yet, or `CONVEX_HTTP_URL` points at the wrong
 * deployment. Convex's routing 404 is not this JSON shape, so callers can
 * throw on it instead of mapping a config error to "entity missing" (which
 * would surface downstream as silent 401s).
 */
export async function isEntityNotFound(
  response: Response,
  expectedError: string
): Promise<boolean> {
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    error?: unknown;
  } | null;
  return body?.ok === false && body?.error === expectedError;
}
