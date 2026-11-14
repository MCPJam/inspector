/**
 * Shared plumbing for the backend's service-token-gated `/internal/v1/*`
 * routes (see mcpjam-backend `convex/http.ts`). Inspector authenticates to
 * them with the service credential via the `x-inspector-service-token`
 * header; `CONVEX_HTTP_URL` is the `.convex.site` HTTP-actions origin those
 * routes are mounted on.
 */
import {
  getServiceCredential,
  requireServiceCredential,
} from "./service-credential.js";

/**
 * The backend origin and the service credential, or a throw. For request-path
 * callers; a background worker deciding whether to start uses
 * {@link serviceRouteEnv}, which never throws.
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

/**
 * Per-request cap on service-route calls so a stalled Convex cannot wedge a
 * worker's poll loop.
 */
export const SERVICE_ROUTE_TIMEOUT_MS = 15_000;

export type ServiceRouteResponse = { status: number; body: any };

export type PostServiceRoute = (
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string> },
) => Promise<ServiceRouteResponse>;

/**
 * The backend origin and the service credential when this deployment is an
 * infrastructure peer, else null. Never throws: background workers call it at
 * startup to decide whether to run at all, and holding no credential is the
 * normal state of every self-hosted build.
 */
export function serviceRouteEnv(): {
  convexUrl: string;
  serviceToken: string;
} | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = getServiceCredential();
  if (!convexUrl || !serviceToken) return null;
  return { convexUrl, serviceToken };
}

/**
 * The configured origin without a trailing slash. Refuses any origin that
 * would put the service token on the wire in cleartext; loopback `http:` is
 * allowed because local development runs Convex over http on 127.0.0.1.
 */
function serviceRouteOrigin(convexUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(convexUrl);
  } catch {
    throw new Error("CONVEX_HTTP_URL is not a valid URL");
  }
  const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback)
  ) {
    throw new Error(
      "Refusing to send the inspector service token to a non-HTTPS " +
        `CONVEX_HTTP_URL (${parsed.protocol}//${parsed.hostname})`,
    );
  }
  return convexUrl.replace(/\/$/, "");
}

const PROTECTED_HEADERS = new Set(["content-type", "x-inspector-service-token"]);

/**
 * A caller's extra headers without the ones the transport sets itself. Header
 * names ignore case, so `X-Inspector-Service-Token` would otherwise survive
 * the spread and reach the server as a second token value.
 */
function extraHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !PROTECTED_HEADERS.has(name.toLowerCase()),
    ),
  );
}

/**
 * POST a JSON body to a service-token-gated route and return its status and
 * parsed body. Every status is returned, not thrown; callers classify it.
 * Extra headers, such as a route's execution grant, cannot replace the
 * content type or the service token.
 */
export async function postServiceRoute(
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string> },
): Promise<ServiceRouteResponse> {
  const env = serviceRouteEnv();
  if (!env) {
    throw new Error(
      "Service routes require CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  const origin = serviceRouteOrigin(env.convexUrl);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVICE_ROUTE_TIMEOUT_MS,
  );
  // The timer stays armed through the BODY read, not just the headers: a
  // response that stalls mid-body would otherwise hang the poll loop for as long
  // as the socket stays open, and the loop is what recovers from a sick backend.
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        ...extraHeaders(options?.headers),
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // `fetch` follows redirects by default and replays the request headers to
      // wherever it lands, which would hand the service token, and any grant,
      // to another origin. Refuse to follow; the credentials stay with the
      // configured host.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `service route ${path} redirected (${response.status}); refusing to forward the service token`,
      );
    }
    let parsed: unknown = null;
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
          { cause: error },
        );
      }
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}
