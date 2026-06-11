/**
 * Public v1 catalog reads — thin proxies over the Convex `/v1/*` read surface.
 *
 * This makes the Inspector `/api/v1` the ONE public API surface: callers
 * (including `sk_` API keys, which Convex cannot validate) get the resource
 * listings here, on the same host and path conventions as every other v1
 * route. The Convex `/v1/*` routes (convex/publicApi/routes.ts) remain the
 * backing implementation — these handlers only translate path-param style to
 * Convex's query-param style and swap in a Convex-acceptable bearer.
 *
 * The bearer comes from `getConvexBearerForRequest`: JWT callers pass
 * through verbatim; WorkOS API-key callers get the short-lived delegated
 * JWT, so the backend's fail-closed org scoping applies to every read.
 *
 * Status and body are passed through verbatim — the Convex surface emits the
 * same v1 envelope (resource-direct / `{items, nextCursor?}` /
 * `{code, message, details?}`), enforced by the shared contract fixtures.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

const catalog = new Hono();

const PROXY_TIMEOUT_MS = 15_000;

/** Copy whitelisted query params from the incoming request onto the target. */
function forwardQueryParams(
  c: Context,
  target: URL,
  names: readonly string[]
): void {
  for (const name of names) {
    const value = c.req.query(name);
    if (typeof value === "string" && value.length > 0) {
      target.searchParams.set(name, value);
    }
  }
}

async function proxyConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void
): Promise<Response> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const bearer = await getConvexBearerForRequest(c);
  const target = new URL(convexPath, convexUrl);
  configure?.(target);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error as { code?: string }).code === "ABORT_ERR");
    throw new WebRouteError(
      isAbort ? 504 : 502,
      isAbort ? ErrorCode.TIMEOUT : ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `Catalog read timed out after ${PROXY_TIMEOUT_MS}ms`
        : "Failed to reach the catalog service"
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Catalog service returned a non-JSON response (${response.status})`
    );
  }
  // Same envelope on both surfaces — pass status and body through verbatim.
  return c.json(body as Record<string, unknown>, response.status as 200);
}

// GET /v1/me
// The authenticated account behind the key/token.
catalog.get("/me", (c) => proxyConvexV1Read(c, "/v1/me"));

// GET /v1/projects?organizationId=
// Projects the caller can access (org-scoped for API keys).
catalog.get("/projects", (c) =>
  proxyConvexV1Read(c, "/v1/projects", (target) =>
    forwardQueryParams(c, target, ["organizationId"])
  )
);

// GET /v1/projects/:projectId/servers
// Servers saved in the project — the ids every other v1 route takes.
catalog.get("/projects/:projectId/servers", (c) =>
  proxyConvexV1Read(c, "/v1/project-servers", (target) =>
    target.searchParams.set("projectId", c.req.param("projectId"))
  )
);

// GET /v1/projects/:projectId/eval-suites
// Eval suites in the project, with latest-run summaries.
catalog.get("/projects/:projectId/eval-suites", (c) =>
  proxyConvexV1Read(c, "/v1/eval-suites", (target) =>
    target.searchParams.set("projectId", c.req.param("projectId"))
  )
);

// GET /v1/chat-sessions?projectId=&status=&limit=&before=
// Chat sessions visible to the caller. Top-level (not project-nested)
// because the upstream merges personal + project-shared sessions and
// `projectId` is an optional filter, not an owning scope.
catalog.get("/chat-sessions", (c) =>
  proxyConvexV1Read(c, "/v1/chat-sessions", (target) =>
    forwardQueryParams(c, target, ["projectId", "status", "limit", "before"])
  )
);

export default catalog;
