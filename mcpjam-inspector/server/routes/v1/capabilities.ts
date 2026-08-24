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
 *
 * User testing splits FINER than "admin publishes, members read". The scenario
 * mutations behind the day-to-day controls — `setScenarioMode`,
 * `updateScenario`, `rotateScenarioLink`, `upsertScenarioMember`,
 * `removeScenarioMember` — gate at `requireWorkspaceRole(..., 'guest')`
 * upstream: an ordinary member CAN do all of them, and none sit behind the
 * beta flag. Only `publishEnvironmentScenario`, `rebindEnvironmentScenario` and
 * `setScenarioGuestExecution` require project admin, and of those only
 * publish/rebind are flag-gated. Reporting the member-level controls as
 * admin-gated would DENY capabilities callers actually hold — this endpoint's
 * own failure mode, delivered by the endpoint itself.
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
  /**
   * MIRRORS `requireProjectRole`, which ranks the ORGANIZATION role and
   * nothing else — a project grant does not raise it. So membership here is
   * the org rank alone.
   *
   * Deliberately NOT folded in: `projectRole`, whose only values are `admin`
   * and `editor`. Counting `editor` as membership would tell a guest holding a
   * project grant they may author swarms, and every such write would then be
   * refused by the mutation — the exact "claim a capability the caller lacks"
   * failure this endpoint exists to prevent, delivered by the endpoint itself.
   */
  const rank = ROLE_RANK[row.role] ?? 0;
  const isMember = rank >= ROLE_RANK.member;
  /**
   * Publishing checks `canManageProjectMembers`, which IS satisfied by a
   * project `admin` grant on its own — so this is the one capability a
   * non-member can hold, and the backend already folded both sources into
   * `isProjectAdmin`. The org-rank clause is redundant against today's
   * backend and kept as a floor in case that folding ever moves.
   */
  const isAdmin = row.isProjectAdmin || rank >= ROLE_RANK.admin;
  /**
   * Evals do NOT gate the way swarms do, so `isMember` is the wrong predicate
   * for the eval keys and the warning above does not carry over to them.
   *
   * Swarm writes call `requireProjectRole`, which ranks the organization role
   * alone. Eval writes go through `resolveProjectAccess`, where a project
   * GRANT counts: the published edit tier is org rank >= member, OR any
   * project grant, OR a legacy workspace row (mcpjam-backend
   * `convex/lib/evalPermissions.ts`). Reporting `isMember` here would tell a
   * guest holding an editor grant they may not author suites, when the
   * mutation would have accepted every one of those writes.
   *
   * Which makes this `true`, and deliberately so. A guest with no grant does
   * not resolve access at all, and the query behind this route returns null
   * for that caller, so the route 404s before reaching here — every caller who
   * receives this row satisfies the edit tier. It is a constant because the
   * matrix has no viewer-without-edit state to express yet, not because the
   * check was skipped; when a `viewer` grant role exists this stops being one
   * and callers already branching on it keep working.
   */
  const evalsEditTier = true;
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
    /**
     * Mode changes, member invites/removals, link rotation, renames. These
     * gate at WORKSPACE membership upstream (`requireWorkspaceRole(...,
     * 'guest')` on every one of the scenario mutations) — an ordinary member
     * can do all of them — and none of them check the beta flag. Guest
     * execution is NOT here: it is the one exposure control that genuinely
     * needs admin, split out below.
     *
     * KNOWN IMPRECISION, deliberate: workspace access resolves per WORKSPACE
     * (`resolveWorkspaceAccess`), and a non-admin org member is refused on a
     * PRIVATE workspace without an explicit grant. This endpoint answers per
     * project and cannot see per-scenario workspace grants, so a member may
     * read `true` here and still 404 on one specific private scenario. That
     * is the descriptive-not-authoritative contract this file's header
     * states — the alternative, reporting admin-only, denied the capability
     * to every member for every scenario, which is the larger lie.
     */
    changeUserTestingExposure: isMember,
    /**
     * The guest-execution spend caps (`setScenarioGuestExecution`), which are
     * genuinely project-ADMIN upstream (`canManageProjectMembers`, same bar
     * as publishing). Kept separate from `changeUserTestingExposure` so the
     * membership-level controls above are not misreported as admin-only.
     * Ungated: the beta flag covers publish/rebind, not this.
     */
    manageUserTestingGuestExecution: isAdmin,
    /** Requesting an LLM insight pass over a wave or window. */
    requestInsights: isMember,
    /**
     * Reading suites, runs, iterations and traces. The eval read floor is
     * "access resolves at all", which is the same condition under which this
     * endpoint answers instead of 404ing — so a caller holding this row has
     * it. See `evalsEditTier` below for why that is not `isMember`.
     */
    readEvals: evalsEditTier,
    /** Authoring suites and cases, and every write short of deleting. */
    writeEvalSuites: evalsEditTier,
    /** Starting a suite or case run. Spends hosted model credits. */
    launchEvalRun: evalsEditTier,
    /**
     * Deleting a suite someone ELSE created, which is the project MANAGE tier
     * (`hasMinimumRole(role, 'admin') || projectRole === 'admin'` — exactly
     * what `isProjectAdmin` already folds together).
     *
     * Named "any" on purpose. The backend keeps a creator escape hatch: the
     * user who created a suite may delete it whatever their role, which is
     * what lets an interrupted CLI import roll its own half-written suite
     * back. A key called `deleteEvalSuite` reading `false` would tell an
     * ordinary member they cannot delete the suite they just made, and this
     * endpoint's job is to avoid exactly that kind of denied-capability lie.
     */
    deleteAnyEvalSuite: isAdmin,
    /** Same tier, same creator hatch, for runs. */
    deleteAnyEvalRun: isAdmin,
    /**
     * Exporting traces. Project-level floor only: the export path filters row
     * by row against the caller (another member's PRIVATE Playground
     * transcripts are excluded from the export, not merely hidden), so `true`
     * means "the export surface is open to you", never "every session in this
     * project will be in the file".
     */
    exportEvalTraces: evalsEditTier,
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
