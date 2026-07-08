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
import type { SkillProvenance } from "../../../shared/skill-types.js";
import type { ExecutionScope } from "../execution-scope.js";

export type SkillSharing = "user" | "project";

/**
 * Normalize a wire `provenance` value (typed as a plain `string` on DTOs so an
 * enum value a shipped inspector doesn't know can't break deserialization) to a
 * known {@link SkillProvenance}. Absent / unknown ⇒ 'authored' — the legacy
 * default, matching the backend `rowProvenance` read-normalizer.
 */
export function normalizeProvenance(value: string | undefined): SkillProvenance {
  return value === "computer-adopted" ? "computer-adopted" : "authored";
}

export interface CloudSkillListItem {
  skillId: string;
  projectId: string;
  name: string;
  description: string;
  sharing: SkillSharing;
  isOwner: boolean;
  aggregateHash: string;
  /** Wire-tolerant (see {@link normalizeProvenance}); absent ⇒ 'authored'. */
  provenance?: string;
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
  /** Wire-tolerant (see {@link normalizeProvenance}); absent ⇒ 'authored'. */
  provenance?: string;
  aggregateHash: string;
  /**
   * Preserved Agent-Skills-spec frontmatter (license / compatibility /
   * allowed-tools / metadata). The harness `skills` param structurally can't
   * carry it, so `materializeSkillFrontmatter` rewrites the on-box SKILL.md
   * for skills that have it. Absent on older backends (wire-tolerant).
   */
  extraFrontmatter?: SkillExtraFrontmatterInput;
}

/** Preserved Agent-Skills-spec frontmatter (backend re-validates + size-caps). */
export interface SkillExtraFrontmatterInput {
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
}

/** One skill discovered on a Computer, submitted for adoption. */
export interface AdoptSkillInput {
  name: string;
  description: string;
  content: string;
  extraFrontmatter?: SkillExtraFrontmatterInput;
}

/** Per-entry adoption outcome mirrored from the backend mutation. */
export interface AdoptSkillResult {
  name: string;
  status: "adopted" | "exists" | "conflict" | "invalid";
  skillId?: string;
  message?: string;
}

/** Metadata for one supporting file (no content). */
export interface CloudSkillFileMeta {
  path: string;
  size: number;
  contentHash: string;
  updatedAt: number;
}

/** A supporting file for harness materialization (carries a download URL). */
export interface CloudSkillRuntimeFile {
  skillId: string;
  path: string;
  size: number;
  url: string | null;
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
  adopt: "projectSkills:adoptComputerSkills",
  fileUploadUrl: "projectSkills:generateSkillFileUploadUrl",
  attachFiles: "projectSkills:attachSkillFiles",
  removeFile: "projectSkills:removeSkillFile",
  listFiles: "projectSkills:listSkillFiles",
  fileUrl: "projectSkills:getSkillFileUrl",
  filesForRuntime: "projectSkills:listSkillFilesForRuntime",
  filesForRuntimeExecution: "projectSkills:listSkillFilesForRuntimeExecution",
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
    /** Preserved spec frontmatter (backend re-validates + size-caps). */
    extraFrontmatter?: SkillExtraFrontmatterInput;
  },
): Promise<CloudSkillDetail> {
  return await makeClient(bearer).mutation(FN.create as any, args);
}

export async function convexUpdateSkill(
  bearer: string,
  // No `name` — skill names are immutable in v1 (the backend rejects renames).
  args: {
    projectId: string;
    skillId: string;
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

/**
 * Adopt filesystem-installed skills discovered on a Computer into durable Convex
 * storage (batch ≤5, backend-enforced). Per-entry fail-soft results; the backend
 * recomputes the hash and never trusts the client's.
 */
export async function convexAdoptComputerSkills(
  bearer: string,
  projectId: string,
  skills: AdoptSkillInput[],
): Promise<{ results: AdoptSkillResult[] }> {
  return await makeClient(bearer).mutation(FN.adopt as any, {
    projectId,
    skills,
  });
}

// ── supporting files (v2) ──────────────────────────────────────────────────

export async function convexGenerateSkillFileUploadUrl(
  bearer: string,
  projectId: string,
  skillId: string,
): Promise<{ uploadUrl: string }> {
  return await makeClient(bearer).mutation(FN.fileUploadUrl as any, {
    projectId,
    skillId,
  });
}

export async function convexAttachSkillFiles(
  bearer: string,
  projectId: string,
  skillId: string,
  files: { path: string; storageId: string; contentHash: string }[],
): Promise<{ files: CloudSkillFileMeta[] }> {
  return await makeClient(bearer).mutation(FN.attachFiles as any, {
    projectId,
    skillId,
    files,
  });
}

export async function convexRemoveSkillFile(
  bearer: string,
  projectId: string,
  skillId: string,
  path: string,
): Promise<{ removed: boolean }> {
  return await makeClient(bearer).mutation(FN.removeFile as any, {
    projectId,
    skillId,
    path,
  });
}

export async function convexListSkillFiles(
  bearer: string,
  projectId: string,
  skillId: string,
): Promise<CloudSkillFileMeta[]> {
  return await makeClient(bearer).query(FN.listFiles as any, {
    projectId,
    skillId,
  });
}

export async function convexGetSkillFileUrl(
  bearer: string,
  projectId: string,
  skillId: string,
  path: string,
): Promise<{ url: string | null; size: number }> {
  return await makeClient(bearer).query(FN.fileUrl as any, {
    projectId,
    skillId,
    path,
  });
}

export async function convexListSkillFilesForRuntime(
  bearer: string,
  projectId: string,
): Promise<CloudSkillRuntimeFile[]> {
  return await makeClient(bearer).query(FN.filesForRuntime as any, {
    projectId,
  });
}

export async function convexListSkillFilesForRuntimeExecution(
  bearer: string,
  executionScope: ExecutionScope,
): Promise<CloudSkillRuntimeFile[]> {
  return await makeClient(bearer).query(FN.filesForRuntimeExecution as any, {
    executionScope,
  });
}
