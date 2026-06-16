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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

async function fetchConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void
): Promise<{ status: number; body: unknown }> {
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

  // The abort deadline must cover the WHOLE exchange: `fetch` resolves on
  // headers, so clearing the timer there would leave a stalled response
  // body free to hang `response.json()` indefinitely.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    });
    try {
      body = await response.json();
    } catch (parseError) {
      // A body stalled past the deadline rejects with an abort, which is a
      // timeout, not a malformed payload — let the outer classifier map it.
      if (isAbortError(parseError)) throw parseError;
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `Catalog service returned a non-JSON response (${response.status})`
      );
    }
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    const isAbort = isAbortError(error);
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

  return { status: response.status, body };
}

async function proxyConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void
): Promise<Response> {
  const { status, body } = await fetchConvexV1Read(c, convexPath, configure);
  // Same envelope on both surfaces — pass status and body through verbatim.
  return c.json(body as Record<string, unknown>, status as 200);
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
  proxyConvexV1Read(c, "/v1/chat-sessions", (target) => {
    forwardQueryParams(c, target, ["projectId", "status", "limit", "before"]);
    // The public pagination contract is "pass the previous nextCursor as
    // `cursor`"; the Convex upstream's parameter is `before`. Map it here —
    // `cursor` wins over an explicit `before` so the documented pagination
    // loop pages correctly instead of silently re-serving page one.
    const cursor = c.req.query("cursor");
    if (typeof cursor === "string" && cursor.length > 0) {
      target.searchParams.set("before", cursor);
    }
  })
);

// GET /v1/projects/:projectId/chatboxes
// The chatboxes published from the project — name, access mode, attached
// servers, share link.
catalog.get("/projects/:projectId/chatboxes", (c) =>
  proxyConvexV1Read(c, "/v1/chatboxes", (target) =>
    target.searchParams.set("projectId", c.req.param("projectId"))
  )
);

// GET /v1/projects/:projectId/chatboxes/:chatboxId
// One chatbox's read-only settings. Project-nested with a cross-check,
// matching the eval-read contract: the upstream takes a bare chatboxId, so a
// real chatbox living in a different project must read as NOT_FOUND under
// this path rather than leak across projects.
catalog.get("/projects/:projectId/chatboxes/:chatboxId", async (c) => {
  const projectId = c.req.param("projectId");
  const { status, body } = await fetchConvexV1Read(c, "/v1/chatbox", (target) =>
    target.searchParams.set("chatboxId", c.req.param("chatboxId"))
  );
  if (
    status === 200 &&
    String((body as { projectId?: unknown })?.projectId ?? "") !== projectId
  ) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Chatbox not found");
  }
  return c.json(body as Record<string, unknown>, status as 200);
});

export default catalog;
