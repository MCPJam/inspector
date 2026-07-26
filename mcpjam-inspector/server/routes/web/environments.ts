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
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  resolveEnvironmentForRuntime,
  toEnvironmentPreview,
} from "../../services/environments/runtime.js";
import { harnessSupportsSkills } from "../../utils/harness/registry.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { handleRoute } from "./auth.js";
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

export default environments;
