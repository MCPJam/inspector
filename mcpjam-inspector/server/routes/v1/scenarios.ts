/**
 * Public v1 SCENARIO surface — the API for user testing.
 *
 * NAMING. A scenario is what a visitor lands on when you share a link: one
 * project environment, published for people outside the project to talk to.
 * Internally every one of these is a `chatboxes` row, and it will stay that
 * way — this is a transport-DTO rename, not a migration. "Chatbox" is the
 * older name, it is deprecated publicly, and the existing
 * `/projects/:p/chatboxes` reads keep serving until GA.
 *
 * The rename is worth the churn because "chatbox" is ambiguous inside the
 * codebase in a way it never was for customers: `kind:"swarm"`, `swarm_grant`,
 * and `swarmId: v.id('chatboxes')` all refer to GUEST EXECUTION on a chatbox —
 * this product — and have nothing to do with the Swarms product, which lives
 * under `/journeys`. Two products, two nouns.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the chatbox reads in `catalog.ts`: that
 * module is a read-only proxy over the Convex `/v1/*` surface, forwarding
 * whole requests. These are WRITES that call Convex mutations directly, with
 * their own authorization shape and their own error mapping — putting them in
 * a proxy catalog would mean a module where some routes forward and some do
 * not, which is exactly how the fallthrough in `bearer-auth.ts` became a
 * problem elsewhere.
 *
 * AUTHORIZATION. Publishing and unpublishing require project ADMIN (Convex
 * enforces it: a scenario is shared execution config that outsiders can reach).
 * Publishing is additionally behind the `sandboxes-enabled` beta flag, enforced
 * server-side. Unpublishing deliberately is NOT — an org that has just lost the
 * flag must still be able to take a live scenario down.
 *
 * GUESTS. These paths match no rule in `GUEST_ALLOWED_V1_RULES`, so guests are
 * denied by default, which is correct and intended: the existing chatbox GET
 * rules exist for share-link flows, and extending anything guest-shaped to the
 * scenario surface needs its own security review first.
 */
import { Hono } from "hono";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import {
  classifyConvexReadError,
  translateConvexReadError,
} from "./convex-read-errors.js";

const scenarios = new Hono();

/** Convex `chatboxes:publishEnvironmentChatbox` result. */
type PublishedScenarioRow = {
  chatboxId: string;
  environmentId: string;
  name: string;
  mode: "project_members" | "invited_only" | "anyone_with_link";
  accessVersion: number;
  link: string | null;
  created: boolean;
};

function toScenarioDto(row: PublishedScenarioRow) {
  return {
    // `chatboxId` upstream. The public id is the scenario's id; a caller
    // should never have to learn the internal table's name to use this API.
    id: row.chatboxId,
    environmentId: row.environmentId,
    name: row.name,
    /**
     * Who may open the share link:
     *   project_members  — signed-in members of the project only
     *   invited_only     — named members, invited individually
     *   anyone_with_link — anyone holding the URL
     */
    mode: row.mode,
    /**
     * Bumped whenever access is narrowed (mode change, member removal, link
     * rotation). Sessions minted under an older version stop working, which is
     * what makes those changes take effect immediately rather than at expiry.
     */
    accessVersion: row.accessVersion,
    link: row.link,
  };
}

/**
 * ENVIRONMENT PREFLIGHT.
 *
 * The Convex publish mutation takes an `environmentId` alone and checks the
 * caller's access to THAT environment's project — never against the project in
 * this route's path. Without the check below, `PUT /projects/A/environments/
 * {an-env-in-B}/scenario` would publish a scenario in project B for a caller
 * who is an admin of both, under a URL that says A.
 *
 * `projectEnvironments:getEnvironment` scopes by projectId, so an environment
 * from another project comes back null — the same answer as one that does not
 * exist, which is what keeps this from being an existence oracle.
 */
async function requireEnvironmentInProject(
  client: ConvexHttpClient,
  projectId: string,
  environmentId: string
): Promise<void> {
  let row: unknown;
  try {
    row = await client.query(
      "projectEnvironments:getEnvironment" as never,
      {
        projectId,
        environmentId,
      } as never
    );
  } catch (error) {
    // A MEMBERSHIP refusal is a 404, for the same reason a cross-project id is
    // — answering 403 would confirm the environment exists to someone who
    // cannot see it. A bad credential is a 401 and an outage is a 502, because
    // a client told "not found" during either will reasonably conclude the
    // environment is gone and clean up local state. Shared classifier so this
    // and the journey reads cannot drift.
    const failure = classifyConvexReadError(error);
    if (failure.kind !== "membership") {
      throw translateConvexReadError(error, { scope: "v1.scenarios" });
    }
    row = null;
  }
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Environment not found");
  }
}

// PUT /v1/projects/:projectId/environments/:environmentId/scenario
//
// PUT, not POST: publishing is idempotent — one scenario per environment, and
// publishing an already-published environment returns the existing one rather
// than minting a second. `created` says which happened, so a caller can tell
// "I published it" from "it was already there" without a preflight read.
scenarios.put(
  "/projects/:projectId/environments/:environmentId/scenario",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireEnvironmentInProject(client, projectId, environmentId);

    let result: PublishedScenarioRow;
    try {
      result = (await client.mutation(
        "chatboxes:publishEnvironmentChatbox" as never,
        { environmentId } as never
      )) as PublishedScenarioRow;
    } catch (error) {
      // Carries the beta gate's FEATURE_UNAVAILABLE through as a real 403, the
      // admin-role failure as 403, and an archived environment as 409.
      throw translateConvexWriteError(error, {
        resource: "Scenario",
        // The admin gate is worth surfacing here: you are already a project
        // member (Convex checked), so "requires admin" is actionable and
        // reveals nothing you could not otherwise see — the same call
        // environments make, and a scenario IS an environment's publication.
        adminFailureIsForbidden: true,
      });
    }

    return v1Resource(
      c,
      { ...toScenarioDto(result), created: result.created },
      result.created ? 201 : 200
    );
  }
);

// DELETE /v1/projects/:projectId/environments/:environmentId/scenario
//
// Idempotent: unpublishing an environment that has no scenario reports
// `deleted: false` rather than 404. A caller cleaning up should not have to
// know whether the thing it is removing exists.
//
// NOT behind the beta flag — taking a live scenario down must keep working for
// an org that has lost the flag. See lib/sandboxesGate.ts on why exposure-
// reducing writes are ungated.
scenarios.delete(
  "/projects/:projectId/environments/:environmentId/scenario",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireEnvironmentInProject(client, projectId, environmentId);

    let result: { deleted: boolean; chatboxId?: string };
    try {
      result = (await client.mutation(
        "chatboxes:unpublishEnvironmentChatbox" as never,
        { environmentId } as never
      )) as { deleted: boolean; chatboxId?: string };
    } catch (error) {
      throw translateConvexWriteError(error, {
        resource: "Scenario",
        adminFailureIsForbidden: true,
      });
    }

    return v1Resource(c, {
      environmentId,
      deleted: result.deleted,
      ...(result.chatboxId !== undefined ? { id: result.chatboxId } : {}),
    });
  }
);

export default scenarios;
