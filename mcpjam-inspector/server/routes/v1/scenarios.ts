/**
 * Public v1 SCENARIO surface — the API for user testing.
 *
 * NAMING. A scenario is what a visitor lands on when you share a link: one
 * project environment, published for people outside the project to talk to.
 * Internally every one of these is a `scenarios` row, and it will stay that
 * way — this is a transport-DTO rename, not a migration. "Scenario" is the
 * older name, it is deprecated publicly, and the existing
 * `/projects/:p/scenarios` reads keep serving until GA.
 *
 * The rename is worth the churn because "scenario" is ambiguous inside the
 * codebase in a way it never was for customers: `kind:"swarm"`, `swarm_grant`,
 * and `swarmId: v.id('scenarios')` all refer to GUEST EXECUTION on a scenario —
 * this product — and have nothing to do with the Swarms product, which lives
 * under `/journeys`. Two products, two nouns.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the scenario reads in `catalog.ts`: that
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
 * denied by default, which is correct and intended: the existing scenario GET
 * rules exist for share-link flows, and extending anything guest-shaped to the
 * scenario surface needs its own security review first.
 */
import { Hono } from "hono";
import { z } from "zod";
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

/** Convex `scenarios:publishEnvironmentScenario` result. */
type PublishedScenarioRow = {
  scenarioId: string;
  environmentId: string;
  name: string;
  mode: "project_members" | "invited_only" | "anyone_with_link";
  accessVersion: number;
  link: string | null;
  created: boolean;
};

function toScenarioDto(row: PublishedScenarioRow) {
  return {
    // `scenarioId` upstream. The public id is the scenario's id; a caller
    // should never have to learn the internal table's name to use this API.
    id: row.scenarioId,
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

/**
 * Create-time overrides, forwarded to the publish mutation IN THE SAME CALL.
 *
 * The backend accepts these atomically for a specific reason: without them,
 * "publish this restricted to invited people only" is two operations, and
 * between them the scenario is live in the DEFAULT mode. That window is short
 * and real — a link that is briefly wider than the person asked for, on a
 * surface whose entire job is letting outsiders in.
 *
 * This route used to drop them silently, which is worse than not offering
 * them: a caller passing `mode` believed they had closed the window.
 *
 * IGNORED ON A REPUBLISH, because they are create-time only upstream. That is
 * not a gap — changing an existing scenario's mode is `setScenarioMode`, and
 * quietly re-applying `mode` here would make a routine idempotent publish able
 * to widen a scenario someone had since narrowed by hand.
 */
const publishScenarioSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    /**
     * Who may open the share link, at creation:
     *   project_members  — signed-in members of the project only
     *   invited_only     — named members, invited individually
     *   anyone_with_link — anyone holding the URL
     */
    mode: z
      .enum(["project_members", "invited_only", "anyone_with_link"])
      .optional(),
  })
  .optional();

/** The body if there is one. A bodyless publish is the common case. */
async function readOptionalJsonBody(c: {
  req: { text: () => Promise<string> };
}): Promise<unknown> {
  const raw = (await c.req.text()).trim();
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be JSON"
    );
  }
}

// PUT /v1/projects/:projectId/environments/:environmentId/scenario
//
// PUT, not POST: publishing is idempotent — one scenario per environment, and
// publishing an already-published environment returns the existing one rather
// than minting a second. `created` says which happened, so a caller can tell
// "I published it" from "it was already there" without a preflight read.
//
// The optional body carries create-time overrides, forwarded in ONE call so a
// scenario is never briefly live in a wider mode than the caller asked for.
scenarios.put(
  "/projects/:projectId/environments/:environmentId/scenario",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const rawBody = await readOptionalJsonBody(c);
    const parsed = publishScenarioSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues[0]?.message ?? "Invalid request body"
      );
    }
    const overrides = parsed.data ?? {};
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireEnvironmentInProject(client, projectId, environmentId);

    let result: PublishedScenarioRow;
    try {
      result = (await client.mutation(
        "scenarios:publishEnvironmentScenario" as never,
        {
          environmentId,
          ...(overrides.name !== undefined ? { name: overrides.name } : {}),
          ...(overrides.description !== undefined
            ? { description: overrides.description }
            : {}),
          ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
        } as never
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
      {
        ...toScenarioDto(result),
        created: result.created,
        /**
         * True when overrides were sent but the environment was ALREADY
         * published, so they were ignored upstream. Surfaced rather than
         * swallowed: a caller who asked for `invited_only` and got a
         * `anyone_with_link` scenario back needs to know the request did not
         * do what it looks like it did — the mode in the response is the real
         * one, but silence about the discarded intent is how someone concludes
         * a link is restricted when it is not.
         */
        ...(!result.created && Object.keys(overrides).length > 0
          ? { overridesIgnored: true }
          : {}),
      },
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

    let result: { deleted: boolean; scenarioId?: string };
    try {
      result = (await client.mutation(
        "scenarios:unpublishEnvironmentScenario" as never,
        { environmentId } as never
      )) as { deleted: boolean; scenarioId?: string };
    } catch (error) {
      throw translateConvexWriteError(error, {
        resource: "Scenario",
        adminFailureIsForbidden: true,
      });
    }

    return v1Resource(c, {
      environmentId,
      deleted: result.deleted,
      ...(result.scenarioId !== undefined ? { id: result.scenarioId } : {}),
    });
  }
);

export default scenarios;
