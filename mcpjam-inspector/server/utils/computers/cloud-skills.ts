/**
 * Cloud Skills service — Convex-sourced.
 *
 * Skills are durable in Convex (`convex/projectSkills.ts`), NOT on the Computer
 * filesystem, so they survive Computer delete/reset/reprovision and can be
 * shared across a project. This service is a thin adapter over
 * `convex-skills-client.ts`: it forwards the caller's bearer, shapes results for
 * the `/web/skills` routes + chat tools, and maps Convex errors to a
 * `CloudSkillsError` carrying an HTTP-ish status.
 *
 * Reads never touch the Computer (no sandbox wake) — that's the whole point of
 * the Convex-source move. Materialization onto `~/.claude/skills` (for the
 * in-sandbox harness) lives in `materialize-skills.ts`.
 *
 * v1 is SKILL.md-only: a skill is `{name, description, content}`. Supporting
 * files are a v2 add (they'll need `_storage` blobs in the backend).
 */
import {
  convexCreateSkill,
  convexDeleteSkill,
  convexGetSkill,
  convexGetSkillByName,
  convexListSkills,
  convexPromoteSkill,
  convexUpdateSkill,
  type CloudSkillDetail,
  type CloudSkillListItem,
  type SkillSharing,
} from "./convex-skills-client.js";

/** Client-side preflight cap (the backend enforces the real one). */
export const MAX_SKILL_CONTENT_BYTES = 128 * 1024;

export class CloudSkillsError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "CloudSkillsError";
    this.status = status;
  }
}

export interface CloudSkillsContext {
  /** The user's Convex bearer (WorkOS/session JWT; "Bearer " prefix tolerated). */
  authHeader: string;
  projectId: string;
  signal?: AbortSignal;
}

export type { CloudSkillDetail, CloudSkillListItem, SkillSharing };

/**
 * Map a Convex error to a CloudSkillsError with a best-effort HTTP status.
 *
 * NOTE: the backend throws plain `Error`s (mirroring computerEnvironments), and
 * Convex redacts those messages in PRODUCTION — so in prod the status falls back
 * to 500/400 and the message is generic. The operation still fails closed
 * (security holds); richer surfaced messages would need backend `ConvexError`s
 * (tracked as a follow-up). In dev the messages pass through and map precisely.
 */
function mapConvexError(err: unknown): CloudSkillsError {
  if (err instanceof CloudSkillsError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let status = 500;
  if (
    /not authorized|requires project admin|owned by another|only the owner|requires project member/.test(
      lower,
    )
  ) {
    status = 403;
  } else if (/not found/.test(lower)) {
    status = 404;
  } else if (
    /already exists|already shared|already a personal|pick a different name|already have a skill/.test(
      lower,
    )
  ) {
    status = 409;
  } else if (/must be|is required|too large|invalid/.test(lower)) {
    status = 400;
  }
  return new CloudSkillsError(message, status);
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapConvexError(err);
  }
}

export function listCloudSkills(
  ctx: CloudSkillsContext,
): Promise<CloudSkillListItem[]> {
  return run(() => convexListSkills(ctx.authHeader, ctx.projectId));
}

export function getCloudSkill(
  ctx: CloudSkillsContext,
  skillId: string,
): Promise<CloudSkillDetail> {
  return run(() => convexGetSkill(ctx.authHeader, ctx.projectId, skillId));
}

export function getCloudSkillByName(
  ctx: CloudSkillsContext,
  name: string,
): Promise<CloudSkillDetail | null> {
  return run(() => convexGetSkillByName(ctx.authHeader, ctx.projectId, name));
}

export function createCloudSkill(
  ctx: CloudSkillsContext,
  data: {
    name: string;
    description: string;
    content: string;
    sharing?: SkillSharing;
  },
): Promise<CloudSkillDetail> {
  return run(() =>
    convexCreateSkill(ctx.authHeader, { projectId: ctx.projectId, ...data }),
  );
}

export function updateCloudSkill(
  ctx: CloudSkillsContext,
  data: {
    skillId: string;
    name?: string;
    description?: string;
    content?: string;
  },
): Promise<CloudSkillDetail> {
  return run(() =>
    convexUpdateSkill(ctx.authHeader, { projectId: ctx.projectId, ...data }),
  );
}

export function deleteCloudSkill(
  ctx: CloudSkillsContext,
  skillId: string,
): Promise<{ deleted: true }> {
  return run(() => convexDeleteSkill(ctx.authHeader, ctx.projectId, skillId));
}

export function promoteCloudSkill(
  ctx: CloudSkillsContext,
  skillId: string,
): Promise<CloudSkillDetail> {
  return run(() => convexPromoteSkill(ctx.authHeader, ctx.projectId, skillId));
}
