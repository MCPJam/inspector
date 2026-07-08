/**
 * Thin client for the backend `projectSkills` Convex functions.
 *
 * Follows the established inspector→Convex pattern (`ConvexHttpClient` +
 * string function names + local DTOs, like `server/routes/shared/evals.ts`):
 * no generated-type codegen dependency, so the inspector builds independently of
 * the backend. The skill business logic, gating, and uniqueness all live in
 * Convex (`convex/projectSkills.ts`) — this is a transport shim.
 *
 * Auth: the caller passes the user's Convex bearer (a WorkOS/session JWT). For
 * `/web/*` routes get it via `getConvexBearerForRequest(c)`; the harness
 * materializer passes the turn's `authHeader`.
 */
import { ConvexHttpClient } from "convex/browser";
import type { ExecutionScope } from "../execution-scope.js";

export type SkillSharing = "user" | "project";

export interface CloudSkillListItem {
  skillId: string;
  projectId: string;
  name: string;
  description: string;
  sharing: SkillSharing;
  isOwner: boolean;
  aggregateHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface CloudSkillDetail extends CloudSkillListItem {
  content: string;
}

export interface CloudSkillMaterializeItem {
  skillId: string;
  name: string;
  aggregateHash: string;
  /** Full generated SKILL.md (safe frontmatter) — written verbatim on the box. */
  skillMd: string;
}

/**
 * Raw fields for adapter-agnostic harness delivery (the `skills` param). The
 * adapter builds its own frontmatter, so `description`/`content` are unescaped.
 */
export interface CloudSkillRuntimeItem {
  skillId: string;
  name: string;
  description: string;
  content: string;
  aggregateHash: string;
}

/** Convex query/mutation names — kept in one place so a rename is one edit. */
const FN = {
  list: "projectSkills:listSkills",
  get: "projectSkills:getSkill",
  getByName: "projectSkills:getSkillByName",
  forMaterialize: "projectSkills:listSkillsForMaterialize",
  forRuntime: "projectSkills:listSkillsForRuntime",
  // Execution-scoped runtime skills (reachable by guests / swarm grants). Keyed
  // on an opaque executionScope the backend re-resolves — never a raw projectId.
  forRuntimeExecution: "projectSkills:listSkillsForRuntimeExecution",
  create: "projectSkills:createSkill",
  update: "projectSkills:updateSkill",
  del: "projectSkills:deleteSkill",
  promote: "projectSkills:promoteSkillToProject",
} as const;

function stripBearer(token: string): string {
  return token.replace(/^Bearer\s+/i, "").trim();
}

function makeClient(bearer: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL is not configured");
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(stripBearer(bearer));
  return client;
}

export async function convexListSkills(
  bearer: string,
  projectId: string,
): Promise<CloudSkillListItem[]> {
  return await makeClient(bearer).query(FN.list as any, { projectId });
}

export async function convexGetSkill(
  bearer: string,
  projectId: string,
  skillId: string,
): Promise<CloudSkillDetail> {
  return await makeClient(bearer).query(FN.get as any, { projectId, skillId });
}

export async function convexGetSkillByName(
  bearer: string,
  projectId: string,
  name: string,
): Promise<CloudSkillDetail | null> {
  return await makeClient(bearer).query(FN.getByName as any, {
    projectId,
    name,
  });
}

export async function convexListSkillsForMaterialize(
  bearer: string,
  projectId: string,
): Promise<CloudSkillMaterializeItem[]> {
  return await makeClient(bearer).query(FN.forMaterialize as any, {
    projectId,
  });
}

export async function convexListSkillsForRuntime(
  bearer: string,
  projectId: string,
): Promise<CloudSkillRuntimeItem[]> {
  return await makeClient(bearer).query(FN.forRuntime as any, { projectId });
}

/**
 * Execution-scoped runtime skills — the guest/swarm-reachable variant. The
 * backend re-resolves the opaque `executionScope` (stale swarm access version /
 * project mismatch → fail closed) and returns shared-only skills for a swarm
 * grant. Used by the harness path whenever the runtime config carried a scope.
 */
export async function convexListSkillsForRuntimeExecution(
  bearer: string,
  executionScope: ExecutionScope,
): Promise<CloudSkillRuntimeItem[]> {
  return await makeClient(bearer).query(FN.forRuntimeExecution as any, {
    executionScope,
  });
}

export async function convexCreateSkill(
  bearer: string,
  args: {
    projectId: string;
    name: string;
    description: string;
    content: string;
    sharing?: SkillSharing;
  },
): Promise<CloudSkillDetail> {
  return await makeClient(bearer).mutation(FN.create as any, args);
}

export async function convexUpdateSkill(
  bearer: string,
  args: {
    projectId: string;
    skillId: string;
    name?: string;
    description?: string;
    content?: string;
  },
): Promise<CloudSkillDetail> {
  return await makeClient(bearer).mutation(FN.update as any, args);
}

export async function convexDeleteSkill(
  bearer: string,
  projectId: string,
  skillId: string,
): Promise<{ deleted: true }> {
  return await makeClient(bearer).mutation(FN.del as any, {
    projectId,
    skillId,
  });
}

export async function convexPromoteSkill(
  bearer: string,
  projectId: string,
  skillId: string,
): Promise<CloudSkillDetail> {
  return await makeClient(bearer).mutation(FN.promote as any, {
    projectId,
    skillId,
  });
}
