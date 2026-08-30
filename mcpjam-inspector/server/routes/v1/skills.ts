/**
 * Public v1 Cloud Skills surface — READ-ONLY.
 *
 * A project skill is an authored SKILL.md stored in Convex (not on any
 * Computer), pinned into environments by `skillSelection.skillIds` and into
 * eval runs by `--compose-skill`. Both of those take skill IDs — and until
 * this route existed there was NO way to obtain an ID from an unattended
 * caller: authoring lives on `/api/web/skills/*` (browser/session surface) and
 * the CLI is a thin client over `/api/v1`. So the CLI demanded an identifier
 * it gave you no way to discover, and the answer was "open the web app".
 *
 * Reads only, deliberately, for the same reason as `plugins.ts`: authoring is
 * a project-admin app flow, and this surface feeds unattended callers (CLI,
 * the platform MCP worker) where no skill write belongs. It is also why this
 * route is not gated on `skills-enabled` — the backend gates AUTHORING
 * (`convex/projectSkills.ts` → `requireSkillsFeature`); reads and deletes stay
 * ungated, and a flagged-off org listing zero skills is a correct answer.
 *
 * Thin proxies over the Convex `projectSkills:*` member-gated reads, called
 * with the request's Convex bearer. Both scope on the path's `projectId` and
 * let Convex enforce membership, like the environments and plugins routes.
 */
import { Hono } from "hono";
import { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const skills = new Hono();

// ── Convex row shapes (hand-mirrored from convex/projectSkills.ts) ───────────
//
// Mirrored by hand rather than imported: the backend is a separate repo, so a
// field added there is invisible here until someone widens these types. Keep
// every added field OPTIONAL so an older inspector against a newer backend
// deserializes rather than throws.

type SkillListRow = {
  skillId: string;
  projectId: string;
  name: string;
  description: string;
  sharing: "user" | "project";
  isOwner: boolean;
  aggregateHash: string;
  provenance?: string;
  pinnability?: { ok: true } | { ok: false; reason: string };
  createdAt: number;
  updatedAt: number;
};

type SkillDetailRow = SkillListRow & { content: string };

/**
 * `pinnability` is the field that makes this listing actionable rather than
 * merely informative: an id that cannot be pinned is not a usable answer to
 * "what can I pass to --compose-skill". Absent on older backends, so it is
 * forwarded only when present rather than defaulted — inventing `{ok:true}`
 * would turn an unknown into a promise we cannot keep.
 */
function toSkillDto(row: SkillListRow) {
  return {
    id: row.skillId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    sharing: row.sharing,
    isOwner: row.isOwner,
    aggregateHash: row.aggregateHash,
    ...(row.provenance !== undefined ? { provenance: row.provenance } : {}),
    ...(row.pinnability !== undefined
      ? { pinnability: row.pinnability }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSkillDetailDto(row: SkillDetailRow) {
  return { ...toSkillDto(row), content: row.content };
}

function createConvexClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}

/**
 * `projectSkills:*` reads throw structured `ConvexError` data: `NOT_FOUND` for
 * a missing id, `FORBIDDEN` for a non-member. Both collapse to 404 — telling a
 * non-member that a skill id exists would be a free existence oracle, the same
 * reasoning as `translatePluginReadError`.
 */
function translateSkillReadError(error: unknown): WebRouteError {
  const data = (error as { data?: unknown } | null)?.data;
  const code =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { code?: unknown }).code
      : undefined;
  if (code === "NOT_FOUND" || code === "FORBIDDEN") {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Skill not found");
  }
  return translateConvexReadError(error, {
    scope: "v1/skills",
    notFoundMessage: "Skill or project not found, or you do not have access.",
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/skills — every skill VISIBLE to the caller in
// this project: the project-shared ones plus the caller's own personal drafts.
// Only `sharing: "project"` rows are pinnable into an environment, which is
// what `pinnability` reports per row.
skills.get("/projects/:projectId/skills", async (c) => {
  const projectId = c.req.param("projectId");
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let rows: SkillListRow[] | null | undefined;
  try {
    rows = (await readClient.query(
      "projectSkills:listSkills" as any,
      { projectId } as any
    )) as SkillListRow[] | null | undefined;
  } catch (error) {
    throw translateSkillReadError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toSkillDto));
});

// GET /v1/projects/:projectId/skills/:skillId — one skill, including its
// SKILL.md body. The body is here because the caller most likely to want it is
// diffing two arms of a skill A/B, and making that a second round-trip through
// a different surface is the gap this route exists to close.
skills.get("/projects/:projectId/skills/:skillId", async (c) => {
  const projectId = c.req.param("projectId");
  const skillId = c.req.param("skillId");
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let row: SkillDetailRow | null | undefined;
  try {
    row = (await readClient.query(
      "projectSkills:getSkill" as any,
      { projectId, skillId } as any
    )) as SkillDetailRow | null | undefined;
  } catch (error) {
    throw translateSkillReadError(error);
  }
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Skill not found");
  }
  return v1Resource(c, toSkillDetailDto(row));
});

export default skills;
