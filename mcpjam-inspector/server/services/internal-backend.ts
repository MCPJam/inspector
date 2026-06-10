/**
 * Shared plumbing for the backend's service-token-gated `/internal/v1/*`
 * routes (see mcpjam-backend `convex/http.ts`). Inspector authenticates to
 * them with `INSPECTOR_SERVICE_TOKEN` via the `x-inspector-service-token`
 * header; `CONVEX_HTTP_URL` is the `.convex.site` HTTP-actions origin those
 * routes are mounted on.
 */

export function getInternalBackendConfig(): {
  convexUrl: string;
  serviceToken: string;
} {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }
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
