/**
 * What the caller may do in a project — asked BEFORE they try it.
 *
 * Every agent surface MCPJam ships is static. The MCP tool catalog is one list
 * built with no organization in hand; the CLI's command tree is fixed at
 * install; the headless agent's registry is compiled in. None of them can
 * advertise "Swarms, but only for orgs in the beta" or "publishing, but only
 * if you are a project admin". So an agent planning a task has exactly two
 * options: attempt the write and read the failure, or ask.
 *
 * Attempting is the expensive one, and not because of the wasted call — it is
 * because by the time the 403 arrives the agent has usually already told a
 * human what it was about to do. This endpoint is the other option.
 *
 * PLANNING AID, NOT A GATE. Every enforcement point stays exactly where it
 * was: `requireProjectRole` and `requireSandboxesEnabled` run inside Convex on
 * the write path regardless of what this returned a second earlier. A caller
 * that reads `enforced: false` and races a flag flip gets the same clean
 * FEATURE_UNAVAILABLE it would have got without asking. Nothing downstream may
 * ever consult this instead of its own check — that would move the boundary
 * into a read that exists to be convenient.
 *
 * 404-never-403, like the rest of the surface: a project the caller cannot see
 * answers "not found" rather than confirming it exists.
 */
import { Hono } from "hono";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Resource } from "./envelope.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { resolveAgentSurface } from "../../utils/agent-attribution.js";

const capabilities = new Hono();

type CapabilitiesRow = {
  projectId: string;
  organizationId: string | null;
  role: "guest" | "member" | "admin" | "owner";
  projectRole: string;
  isProjectAdmin: boolean;
  /**
   * OPTIONAL in this hand-mirror, though the backend always sends it today.
   * This route's entire job is to let a caller plan safely; if the projection
   * ever lags the mirror, degrading to "no gated features" beats throwing an
   * opaque 500 at the one endpoint someone calls to avoid surprises.
   */
  features?: {
    sandboxes?: {
      flagEnabled: boolean;
      reason?: string;
      mode: "off" | "dark" | "enforce";
      enforced: boolean;
    };
  };
  plan: {
    name: string;
    limits: Record<string, unknown>;
    features: Record<string, unknown>;
  } | null;
};

const ROLE_RANK: Record<string, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * The capability names an agent actually branches on, derived here rather than
 * left for each caller to re-derive from `role` + flag state.
 *
 * Derived centrally because the mapping is not obvious and getting it wrong is
 * silent: publishing a scenario needs project ADMIN while authoring a journey
 * needs member, and the beta gate covers exposure-CREATING writes but
 * deliberately not the ones that reduce exposure — so `cancelRun` and
 * `unpublishScenario` stay true for an org that has just lost the flag. An
 * agent that inferred "no flag ⇒ nothing works" would refuse to stop a run
 * precisely when stopping it matters most.
 */
/** The gate state, or the permissive default when the projection lacks it. */
function sandboxesOf(row: CapabilitiesRow) {
  return (
    row.features?.sandboxes ?? {
      flagEnabled: false,
      mode: "off" as const,
      // Not `true`. An absent projection means we do not know, and claiming a
      // caller is gated would make an agent refuse work the platform allows —
      // the write still enforces for real either way.
      enforced: false,
    }
  );
}

function deriveCapabilities(row: CapabilitiesRow) {
  // A PROJECT-level grant can raise an org member to project admin, and the
  // backend already folded that into `isProjectAdmin`. Membership itself comes
  // from either side: an unranked org role with a project grant is still a
  // member of this project.
  const rank = ROLE_RANK[row.role] ?? 0;
  const isMember =
    rank >= ROLE_RANK.member ||
    row.isProjectAdmin ||
    row.projectRole === "member" ||
    row.projectRole === "admin";
  const isAdmin = row.isProjectAdmin || rank >= ROLE_RANK.admin;
  // `enforced` already folds in the gate MODE: in `dark` the flag is evaluated
  // and logged but not applied, so a would-be denial is not a denial and an
  // agent must not plan around one.
  const gated = sandboxesOf(row).enforced;

  return {
    /** Reads across swarms and user testing. Never flag-gated. */
    readSwarms: isMember,
    readUserTesting: isMember,
    /** Authoring personas / journeys / swarms. */
    writeSwarms: isMember && !gated,
    /** Launching a run. Spends hosted model credits. */
    launchJourneyRun: isMember && !gated,
    /** Stopping a run. Ungated by design — see above. */
    cancelJourneyRun: isMember,
    /** Publishing an environment for outsiders to talk to. Admin-only. */
    publishUserTestingScenario: isAdmin && !gated,
    /** Taking a live scenario down. Ungated by design. */
    unpublishUserTestingScenario: isAdmin,
    /** Widening exposure: mode changes, guest execution, member invites. */
    changeUserTestingExposure: isAdmin && !gated,
    /** Requesting an LLM insight pass over a wave or window. */
    requestInsights: isMember,
  };
}

// GET /v1/projects/:projectId/capabilities
capabilities.get("/projects/:projectId/capabilities", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));

  let row: CapabilitiesRow | null;
  try {
    row = (await client.query(
      "projects:getProjectCapabilities" as never,
      { projectId } as never
    )) as CapabilitiesRow | null;
  } catch (error) {
    throw translateConvexReadError(error, { scope: "v1.capabilities" });
  }
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Project not found");
  }

  return v1Resource(c, {
    projectId: row.projectId,
    organizationId: row.organizationId,
    role: row.role,
    projectRole: row.projectRole,
    /**
     * Which channel we resolved this request to arrive on. Echoed so an agent
     * can confirm it is labelled the way it expects — a CLI that shows up as
     * `rest` means its user agent is not reaching us, and that silently
     * degrades every audit row it writes.
     */
    surface: resolveAgentSurface(c),
    features: {
      sandboxes: {
        enabled: sandboxesOf(row).flagEnabled,
        /**
         * `off` | `dark` | `enforce`. Only `enforce` turns a disabled flag
         * into a refusal; in `dark` the platform logs what it would have
         * blocked and lets the write through.
         */
        mode: sandboxesOf(row).mode,
        enforced: sandboxesOf(row).enforced,
        ...(sandboxesOf(row).reason !== undefined
          ? { reason: sandboxesOf(row).reason }
          : {}),
      },
    },
    plan: row.plan,
    can: deriveCapabilities(row),
  });
});

export default capabilities;
