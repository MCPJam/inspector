/**
 * Browser-facing Project Environment routes (Phase 1.3).
 *
 * ONE route today: a read-only PREVIEW of what an environment currently
 * resolves to, so a surface can show "this is what would run" before anyone
 * spends a turn on it.
 *
 * Two boundaries this file exists to hold:
 *
 *  1. The browser must never call `/api/v1` (the session-token allowlist only
 *     admits `/api/v1/harness/`), so the preview lives on `/api/web/*` beside
 *     every other browser-reachable launch surface.
 *  2. The preview is a NARROW projection, not the runtime spec. Skill bodies,
 *     signed supporting-file URLs, server secrets and raw computer/mcpProfile
 *     configuration never cross this line — see `toEnvironmentPreview`, which
 *     projects field by field precisely so that a field added to the runtime
 *     spec cannot arrive here by accident.
 *
 * Authorization is the backend's: `resolveEnvironmentForRuntime` is a
 * member-read. Client EXPOSURE is gated by the `project-environments-enabled`
 * PostHog flag (`useProjectEnvironmentsEnabled`, fail-closed); the server
 * accepts the contract unconditionally because the query is member-gated and a
 * server-side flag would only add a second, drifting gate.
 */
import { Hono } from "hono";
import { HOSTED_MODE, WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  resolveEnvironmentForRuntime,
  runtimeServerIds,
  runtimeServerNames,
  toEnvironmentPreview,
} from "../../services/environments/runtime.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { xaaPolicyFromMcpProfile } from "../../utils/effective-auth.js";
import { harnessSupportsSkills } from "../../utils/harness/registry.js";
import { logger } from "../../utils/logger.js";
import { listTools } from "../../utils/route-handlers.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  callerContextFromHono,
  createAuthorizedManager,
  handleRoute,
} from "./auth.js";
import { ErrorCode, WebRouteError } from "./errors.js";

const environments = new Hono();

// GET /api/web/environments/:environmentId/preview?projectId=...
//
// Read-only. Never applies a per-turn server override: a preview describes the
// environment itself, and letting a caller shape it would show a configuration
// nobody saved.
environments.get("/:environmentId/preview", async (c) =>
  handleRoute(c, async () => {
    const environmentId = c.req.param("environmentId");
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required"
      );
    }
    const spec = await resolveEnvironmentForRuntime(
      // `sk_…` API-key bearers can't query Convex directly; this resolves the
      // delegated JWT and passes real JWTs through untouched.
      createConvexClient(await getConvexBearerForRequest(c)),
      { projectId, environmentId }
    );
    return toEnvironmentPreview(spec, { harnessSupportsSkills });
  })
);

// GET /api/web/environments/:environmentId/tools?projectId=...
//
// The environment's live tool surface: resolve the environment atomically
// (same read as the preview), open the SAME ephemeral per-turn connections a
// chat turn would (`createAuthorizedManager` over the resolved server ids —
// the only path that can reach plugin-contributed servers, which the ordinary
// name-keyed project-server routes cannot represent), list each server's
// tools, and disconnect. Nothing persists past the request.
//
// Per-server failures are per-server ROWS, not a route failure: an
// environment with one unreachable server still shows every other server's
// tools, and the error string doubles as a pre-turn health check.
environments.get("/:environmentId/tools", async (c) =>
  handleRoute(c, async () => {
    const environmentId = c.req.param("environmentId");
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required"
      );
    }
    const bearerToken = await getConvexBearerForRequest(c);
    const spec = await resolveEnvironmentForRuntime(
      createConvexClient(bearerToken),
      { projectId, environmentId }
    );
    const serverIds = runtimeServerIds(spec);
    const serverNames = runtimeServerNames(spec);
    const sources = Array.isArray(spec.servers.connectable)
      ? spec.servers.connectable.map((entry) => entry.source ?? null)
      : serverIds.map(() => null);
    if (serverIds.length === 0) return { servers: [] };

    // Same enterprise-policy posture as an environment chat turn (chat-v2):
    // the policy comes from the environment's own resolved host config —
    // there is no request body here to even be tempted by. Resolved ONCE and
    // fail-closed for the whole route (a malformed policy is an environment
    // problem, not one server's).
    const xaaPolicy = xaaPolicyFromMcpProfile(
      (spec.host.runtimeConfig as { mcpProfile?: unknown } | null)?.mcpProfile
    );
    const xaaIssuer = resolveXaaIssuer(c, HOSTED_MODE);
    const caller = callerContextFromHono(c);

    // ONE manager per server, not one batch: `createAuthorizedManager`
    // validates the whole batch before connecting (correct for a turn, which
    // runs all-or-nothing), so a single server's authorization/XAA failure
    // would blank the entire panel. Here per-server isolation is the point —
    // every failure, including an authorization one, degrades to that
    // server's row.
    const servers = await Promise.all(
      serverIds.map(async (serverId, index) => {
        const name = serverNames[index] ?? serverId;
        const source = sources[index] ?? null;
        try {
          const { manager } = await createAuthorizedManager(
            caller,
            bearerToken,
            projectId,
            [serverId],
            WEB_CALL_TIMEOUT_MS,
            undefined,
            undefined,
            {
              ...(serverNames.length > 0 ? { serverNames: [name] } : {}),
              xaaPolicy,
              xaaIssuer,
            }
          );
          try {
            // Bypass the response cache like every hosted direct-op: this
            // read is the user's "is my environment healthy" signal.
            const result = await listTools(manager, {
              serverId,
              cacheMode: "bypass",
            });
            return { serverId, name, source, tools: result.tools ?? [] };
          } finally {
            // Teardown failures are NOT listing failures. A rejecting
            // disconnect thrown from `finally` would replace the successful
            // return value and land in the catch below, reporting a healthy
            // server as unreachable and discarding tools already in hand.
            // Swallowed to one warn: the connection is ephemeral and the
            // request is over either way.
            await manager.disconnectAllServers().catch((error: unknown) => {
              logger.warn("[web/environments] tools listing teardown failed", {
                serverId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        } catch (error) {
          return {
            serverId,
            name,
            source,
            tools: [],
            error:
              error instanceof Error ? error.message : "Failed to list tools",
          };
        }
      })
    );
    return { servers };
  })
);

export default environments;
