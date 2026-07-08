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
 * the Convex-source move. Delivery to the in-sandbox harness is separate: the
 * harness `skills` param (see `harness/runtime-skills.ts`), with on-box cleanup
 * in `harness/reconcile-skill-dirs.ts`.
 *
 * A skill is `{name, description, content}` plus optional supporting files
 * (v2) — each a `_storage` blob in the backend, uploaded browser→Convex and
 * registered via attachCloudSkillFiles; read back server-side (readCloudSkillFile).
 */
import {
  convexAttachSkillFiles,
  convexCreateSkill,
  convexDeleteSkill,
  convexGenerateSkillFileUploadUrl,
  convexGetSkill,
  convexGetSkillByName,
  convexGetSkillFileUrl,
  convexListSkillFiles,
  convexListSkills,
  convexPromoteSkill,
  convexRemoveSkillFile,
  convexUpdateSkill,
  type CloudSkillDetail,
  type CloudSkillFileMeta,
  type CloudSkillListItem,
  type SkillSharing,
} from "./convex-skills-client.js";
import { getMimeType, isTextMimeType } from "../skill-parser.js";
import type { SkillFileContent } from "../../../shared/skill-types.js";

/** Client-side preflight cap (the backend enforces the real one). */
export const MAX_SKILL_CONTENT_BYTES = 128 * 1024;
/** Text is inlined up to 1MB (matches the local FS reader); larger ⇒ base64. */
export const MAX_SKILL_FILE_TEXT_BYTES = 1024 * 1024;
/** Hard read cap — the backend caps files at 2MB; refuse anything larger. */
export const SKILL_FILE_MAX_READ_BYTES = 2 * 1024 * 1024;

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

const CODE_STATUS: Record<string, number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

/** Read a `ConvexError`'s structured `{ code, message }` payload, if present. */
function convexErrorData(
  err: unknown
): { code?: string; message?: string } | null {
  const data = (err as { data?: unknown })?.data;
  if (data && typeof data === "object") return data as { code?: string };
  return null;
}

/**
 * Map a Convex error to a CloudSkillsError with an HTTP status.
 *
 * Primary path: the backend throws `ConvexError({ code, message })` for expected
 * failures — `code` + `message` survive Convex's production redaction, so we map
 * the code → status precisely (and surface the message). Fallback (a plain
 * `Error` / unexpected fault): regex the message in dev, else opaque 500.
 */
function mapConvexError(err: unknown): CloudSkillsError {
  if (err instanceof CloudSkillsError) return err;

  const data = convexErrorData(err);
  if (data?.code && CODE_STATUS[data.code] !== undefined) {
    return new CloudSkillsError(
      data.message ?? "Skill request failed",
      CODE_STATUS[data.code]
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let status = 500;
  if (
    /not authorized|requires project admin|owned by another|only the owner|requires project member/.test(
      lower
    )
  ) {
    status = 403;
  } else if (/not found/.test(lower)) {
    status = 404;
  } else if (
    /already exists|already shared|already a personal|pick a different name|already have a skill/.test(
      lower
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
  ctx: CloudSkillsContext
): Promise<CloudSkillListItem[]> {
  return run(() => convexListSkills(ctx.authHeader, ctx.projectId));
}

export function getCloudSkill(
  ctx: CloudSkillsContext,
  skillId: string
): Promise<CloudSkillDetail> {
  return run(() => convexGetSkill(ctx.authHeader, ctx.projectId, skillId));
}

export function getCloudSkillByName(
  ctx: CloudSkillsContext,
  name: string
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
  }
): Promise<CloudSkillDetail> {
  return run(() =>
    convexCreateSkill(ctx.authHeader, { projectId: ctx.projectId, ...data })
  );
}

export function updateCloudSkill(
  ctx: CloudSkillsContext,
  data: {
    skillId: string;
    name?: string;
    description?: string;
    content?: string;
  }
): Promise<CloudSkillDetail> {
  return run(() =>
    convexUpdateSkill(ctx.authHeader, { projectId: ctx.projectId, ...data })
  );
}

export function deleteCloudSkill(
  ctx: CloudSkillsContext,
  skillId: string
): Promise<{ deleted: true }> {
  return run(() => convexDeleteSkill(ctx.authHeader, ctx.projectId, skillId));
}

export function promoteCloudSkill(
  ctx: CloudSkillsContext,
  skillId: string
): Promise<CloudSkillDetail> {
  return run(() => convexPromoteSkill(ctx.authHeader, ctx.projectId, skillId));
}

// ── supporting files (v2) ──────────────────────────────────────────────────

export type { CloudSkillFileMeta };

export function generateCloudSkillFileUploadUrl(
  ctx: CloudSkillsContext,
  skillId: string
): Promise<{ uploadUrl: string }> {
  return run(() =>
    convexGenerateSkillFileUploadUrl(ctx.authHeader, ctx.projectId, skillId)
  );
}

export function attachCloudSkillFiles(
  ctx: CloudSkillsContext,
  skillId: string,
  files: { path: string; storageId: string; contentHash: string }[]
): Promise<{ files: CloudSkillFileMeta[] }> {
  return run(() =>
    convexAttachSkillFiles(ctx.authHeader, ctx.projectId, skillId, files)
  );
}

export function removeCloudSkillFile(
  ctx: CloudSkillsContext,
  skillId: string,
  path: string
): Promise<{ removed: boolean }> {
  return run(() =>
    convexRemoveSkillFile(ctx.authHeader, ctx.projectId, skillId, path)
  );
}

export function listCloudSkillFiles(
  ctx: CloudSkillsContext,
  skillId: string
): Promise<CloudSkillFileMeta[]> {
  return run(() =>
    convexListSkillFiles(ctx.authHeader, ctx.projectId, skillId)
  );
}

/**
 * Read a supporting file's content by resolving its `_storage` URL and fetching
 * the bytes SERVER-SIDE (the browser never sees the storage URL). Returns a
 * {@link SkillFileContent} shaped exactly like the local FS reader: text inlined
 * up to 1MB, larger/binary as base64.
 */
export function readCloudSkillFile(
  ctx: CloudSkillsContext,
  skillId: string,
  path: string
): Promise<SkillFileContent> {
  return run(async () => {
    const { url, size } = await convexGetSkillFileUrl(
      ctx.authHeader,
      ctx.projectId,
      skillId,
      path
    );
    if (!url) throw new CloudSkillsError("Skill file not found", 404);
    // Guard on the server-verified size BEFORE fetching so a large blob can't
    // force buffering the whole payload in memory. The backend caps files at
    // 2MB, so anything above that is anomalous.
    if (size > SKILL_FILE_MAX_READ_BYTES) {
      throw new CloudSkillsError(
        `Skill file too large to read (${size} bytes).`,
        413
      );
    }
    // Combine the caller's disconnect signal with an explicit timeout so a slow
    // `_storage` response can't hold the worker indefinitely.
    const timeout = AbortSignal.timeout(30_000);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeout])
      : timeout;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new CloudSkillsError(
        `Failed to read skill file (${res.status})`,
        502
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mimeType = getMimeType(path);
    const name = path.split("/").pop() ?? path;
    const isText =
      isTextMimeType(mimeType) && bytes.byteLength <= MAX_SKILL_FILE_TEXT_BYTES;
    if (isText) {
      return {
        path,
        name,
        content: new TextDecoder().decode(bytes),
        mimeType,
        size: bytes.byteLength,
        isText: true,
      };
    }
    return {
      path,
      name,
      base64: Buffer.from(bytes).toString("base64"),
      mimeType,
      size: bytes.byteLength,
      isText: false,
    };
  });
}
