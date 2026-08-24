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
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { captureServerEvent } from "../../utils/analytics.js";
import {
  fetchConvexV1Read,
  forwardQueryParams,
  proxyConvexV1Read,
} from "./convex-v1-proxy.js";

const catalog = new Hono();

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

// GET /v1/projects/:projectId/sessions?q=&scope=&sourceType=&status=&limit=&cursor=
//
// The unified, cross-surface sessions feed — Playground, user testing, evals,
// and swarms in one project-scoped list. PROJECT-NESTED, unlike
// `/chat-sessions` below: `projectId` is REQUIRED upstream and owns the scope,
// so it belongs in the path rather than as an optional filter.
//
// `cursor` passes through unrenamed (the upstream's own parameter is `cursor`
// here, not `before`), and no parameter is rewritten — the upstream owns
// validation, and re-deriving it here would be a second place to get the
// scope/q interaction wrong.
catalog.get("/projects/:projectId/sessions", async (c) => {
  const response = await proxyConvexV1Read(c, "/v1/sessions", (target) => {
    target.searchParams.set("projectId", c.req.param("projectId"));
    forwardQueryParams(c, target, [
      "sourceType",
      "status",
      "q",
      "scope",
      "limit",
      "cursor",
    ]);
  });

  // Instrumentation rides on the RESPONSE, so a rejected or unauthorized
  // search is not counted as a search that happened. Best-effort and
  // non-blocking: a parse failure here must never change what the caller gets.
  try {
    if (response.status === 200) {
      const body = (await response.clone().json()) as {
        items?: unknown[];
        nextCursor?: string;
        scope?: string;
      };
      const sourceType = c.req.query("sourceType");
      // API-key callers never pass the Convex authorize exchange that fills
      // `userExternalId`, so without this the event has no distinct_id and
      // `captureServerEvent` drops it — leaving the metric describing guests
      // only, which is the opposite of the population it exists to measure.
      // Same fill-in the v1 agent surface does (`agent.ts::captureTurnEvent`).
      const logContext = c.var.requestLogContext as
        | { userExternalId?: string | null }
        | undefined;
      const workosUserId = c.get("workosUserId");
      if (logContext && !logContext.userExternalId && workosUserId) {
        c.set("requestLogContext", {
          ...logContext,
          userExternalId: workosUserId,
        });
      }
      captureServerEvent(c, "api_sessions_search", {
        // The honored scope, not the requested one — the upstream is the
        // authority on which search actually ran.
        scope: body.scope ?? null,
        // NON-EMPTY, matching what was forwarded: `forwardQueryParams` drops
        // `q=`, so the upstream ran a list. Counting that as a search would
        // inflate the metric with the requests it is meant to be compared
        // against.
        hasQuery: (c.req.query("q") ?? "").length > 0,
        itemCount: Array.isArray(body.items) ? body.items.length : 0,
        hasNextCursor: typeof body.nextCursor === "string",
        // The FILTER, never the query. A sourceType list is a fixed
        // vocabulary; a search term is user content.
        sourceTypes: sourceType ? sourceType.split(",") : null,
        status: c.req.query("status") ?? null,
      });
    }
  } catch {
    // A malformed upstream body is the upstream's problem to report, not a
    // reason to fail the request on the way out.
  }

  return response;
});

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

// GET /v1/trace-exports/otlp — bearer-authenticated OTLP/JSON export. The
// upstream keeps pagination in headers so the body remains a valid OTLP
// ExportTraceServiceRequest; forward those headers verbatim.
catalog.get("/trace-exports/otlp", (c) =>
  proxyConvexV1Read(c, "/v1/trace-exports/otlp", (target) =>
    forwardQueryParams(c, target, [
      "projectId",
      "cursor",
      "limit",
      "sourceTypes",
      "includeContent",
    ])
  )
);

// GET /v1/projects/:projectId/scenarios
// The scenarios published from the project — name, access mode, attached
// servers, share link.
catalog.get("/projects/:projectId/scenarios", (c) =>
  proxyConvexV1Read(c, "/v1/scenarios", (target) =>
    target.searchParams.set("projectId", c.req.param("projectId"))
  )
);

// GET /v1/projects/:projectId/scenarios/:scenarioId
// One scenario's read-only settings. Project-nested with a cross-check,
// matching the eval-read contract: the upstream takes a bare scenarioId, so a
// real scenario living in a different project must read as NOT_FOUND under
// this path rather than leak across projects.
catalog.get("/projects/:projectId/scenarios/:scenarioId", async (c) => {
  const projectId = c.req.param("projectId");
  const { status, body } = await fetchConvexV1Read(c, "/v1/scenario", (target) =>
    target.searchParams.set("scenarioId", c.req.param("scenarioId"))
  );
  if (
    status === 200 &&
    String((body as { projectId?: unknown })?.projectId ?? "") !== projectId
  ) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Scenario not found");
  }
  return c.json(body as Record<string, unknown>, status as 200);
});

export default catalog;
