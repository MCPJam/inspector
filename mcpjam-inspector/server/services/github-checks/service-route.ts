/**
 * The service-token-gated transport to `/internal/v1/github-checks/*`.
 *
 * Extracted from the worker because the plan/verdict loop now speaks to four of
 * these routes from two modules, and two copies of "how do we call the backend"
 * is how a timeout policy or an auth header ends up applied on one path and not
 * the other.
 */

export const GITHUB_CHECKS_SERVICE_BASE = "/internal/v1/github-checks";

/**
 * Per-request cap on service-route calls so a stalled Convex cannot wedge the
 * loop.
 */
export const SERVICE_ROUTE_TIMEOUT_MS = 15_000;

export type ServiceRouteResponse = { status: number; body: any };

export type PostServiceRoute = (
  path: string,
  body: Record<string, unknown>
) => Promise<ServiceRouteResponse>;

export function githubChecksServiceEnv(): {
  convexUrl: string;
  serviceToken: string;
} | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) return null;
  return { convexUrl, serviceToken };
}

export async function postServiceRoute(
  path: string,
  body: Record<string, unknown>
): Promise<ServiceRouteResponse> {
  const env = githubChecksServiceEnv();
  if (!env) {
    throw new Error(
      "github-checks worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN"
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVICE_ROUTE_TIMEOUT_MS
  );
  // The timer stays armed through the BODY read, not just the headers: a
  // response that stalls mid-body would otherwise hang the poll loop for as long
  // as the socket stays open, and the loop is what recovers from a sick backend.
  try {
    const response = await fetch(`${env.convexUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch (error) {
      // A malformed body is tolerated — the status carries the signal. A body
      // read that hit the abort deadline is NOT: silently returning
      // `body: null` would make a timed-out call look like a successful one
      // whose response merely lacked a body. Rethrown as a TIMEOUT, since the
      // underlying error is a parse failure and would otherwise read in the
      // logs (and in an `infra_error` detail) as a malformed-response bug.
      if (controller.signal.aborted) {
        throw new Error(
          `service route ${path} timed out after ${SERVICE_ROUTE_TIMEOUT_MS}ms while reading the response body`,
          { cause: error }
        );
      }
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}
