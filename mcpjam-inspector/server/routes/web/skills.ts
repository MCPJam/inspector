/**
 * Cloud Skills — hosted/`/web` routes. The durable, project-scoped skills
 * surface. Skills live in Convex (`convex/projectSkills.ts`), not on any
 * Computer, so reads/writes here never wake a sandbox. v1 is SKILL.md-only.
 *
 * Auth: the user's bearer is exchanged for a Convex bearer
 * (`getConvexBearerForRequest`) and forwarded; Convex enforces membership +
 * admin-for-shared. All UI ops are keyed by `skillId`. `projectId` selects the
 * project on every route.
 */
import { Hono } from "hono";
import { z } from "zod";
import "../../types/hono"; // Type extensions
import type { Context } from "hono";
import {
  ErrorCode,
  WebRouteError,
  handleRoute,
  parseWithSchema,
  readJsonBody,
} from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  CloudSkillsError,
  listCloudSkills,
  getCloudSkill,
  getCloudSkillByName,
  createCloudSkill,
  updateCloudSkill,
  deleteCloudSkill,
  promoteCloudSkill,
  listCloudSkillFiles,
  generateCloudSkillFileUploadUrl,
  attachCloudSkillFiles,
  removeCloudSkillFile,
  readCloudSkillFile,
  MAX_SKILL_CONTENT_BYTES,
  type CloudSkillsContext,
} from "../../utils/computers/cloud-skills.js";
import {
  parseSkillMdWithExtras,
  type ParsedSkillMdWithExtras,
} from "../../utils/skill-extra-frontmatter.js";

const skills = new Hono();

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 409:
      return ErrorCode.VALIDATION_ERROR;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 503:
      return ErrorCode.FEATURE_NOT_SUPPORTED;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}

/** Run a service op, translating CloudSkillsError → WebRouteError. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CloudSkillsError) {
      throw new WebRouteError(
        err.status,
        codeForStatus(err.status),
        err.message,
      );
    }
    throw err;
  }
}

async function ctxFrom(c: Context, projectId: string): Promise<CloudSkillsContext> {
  // Exchange the request bearer for a Convex-usable bearer (handles WorkOS
  // API-key → delegated-JWT; a session JWT passes through).
  const bearer = await getConvexBearerForRequest(c);
  return { authHeader: bearer, projectId, signal: c.req.raw.signal };
}

const projectOnly = z.object({ projectId: z.string().min(1) });
const skillIdSchema = projectOnly.extend({ skillId: z.string().min(1) });
const sharingSchema = z.enum(["user", "project"]).optional();

/**
 * A non-empty skill-content string capped by BYTE length (UTF-8), matching the
 * backend's byte cap. `z.string().max()` counts UTF-16 code units, so a
 * multibyte body could slip past a char cap and be rejected server-side — refine
 * on real byte length instead.
 */
const skillContentSchema = z
  .string()
  .min(1)
  .refine(
    (s) => new TextEncoder().encode(s).length <= MAX_SKILL_CONTENT_BYTES,
    `Skill content must be at most ${MAX_SKILL_CONTENT_BYTES} bytes`,
  );

/**
 * Raw SKILL.md cap: the body cap plus headroom for frontmatter (mirrors the
 * sandbox-adoption scanner's bound-before-parse rule).
 */
const MAX_RAW_SKILL_MD_BYTES = MAX_SKILL_CONTENT_BYTES + 64 * 1024;
const skillMdSchema = z
  .string()
  .min(1)
  .refine(
    (s) => new TextEncoder().encode(s).length <= MAX_RAW_SKILL_MD_BYTES,
    `SKILL.md must be at most ${MAX_RAW_SKILL_MD_BYTES} bytes`,
  );

skills.post("/list", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(projectOnly, await readJsonBody(c));
    const list = await run(async () =>
      listCloudSkills(await ctxFrom(c, body.projectId)),
    );
    return { skills: list };
  }),
);

skills.post("/get", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(skillIdSchema, await readJsonBody(c));
    const skill = await run(async () =>
      getCloudSkill(await ctxFrom(c, body.projectId), body.skillId),
    );
    return { skill };
  }),
);

skills.post("/get-by-name", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      projectOnly.extend({ name: z.string().min(1) }),
      await readJsonBody(c),
    );
    const skill = await run(async () =>
      getCloudSkillByName(await ctxFrom(c, body.projectId), body.name),
    );
    if (!skill) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Skill '${body.name}' not found`,
      );
    }
    return { skill };
  }),
);

skills.post("/create", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      projectOnly.extend({
        name: z.string().min(1),
        description: z.string().min(1),
        content: skillContentSchema,
        sharing: sharingSchema,
        // Optional RAW SKILL.md. When present it is parsed SERVER-SIDE and its
        // description/content/extraFrontmatter become authoritative (the
        // client's naive frontmatter parse drops preserved fields like
        // `allowed-tools`). Absent ⇒ legacy behavior, unchanged.
        skillMd: skillMdSchema.optional(),
      }),
      await readJsonBody(c),
    );
    let description = body.description;
    let content = body.content;
    let extraFrontmatter: ParsedSkillMdWithExtras["extraFrontmatter"];
    if (body.skillMd !== undefined) {
      const parsed = parseSkillMdWithExtras(body.skillMd, "uploaded SKILL.md");
      if (!parsed) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "Invalid SKILL.md — frontmatter must include a valid 'name' and a 'description' (max 1024 characters).",
        );
      }
      if (parsed.name !== body.name) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `SKILL.md frontmatter name '${parsed.name}' does not match the skill name '${body.name}'.`,
        );
      }
      description = parsed.description;
      content = parsed.content;
      extraFrontmatter = parsed.extraFrontmatter;
    }
    const skill = await run(async () =>
      createCloudSkill(await ctxFrom(c, body.projectId), {
        name: body.name,
        description,
        content,
        ...(body.sharing ? { sharing: body.sharing } : {}),
        ...(extraFrontmatter ? { extraFrontmatter } : {}),
      }),
    );
    return { success: true, skill };
  }),
);

skills.post("/update", async (c) =>
  handleRoute(c, async () => {
    // No `name` — skill names are immutable in v1 (the backend rejects renames).
    const body = parseWithSchema(
      skillIdSchema.extend({
        description: z.string().min(1).optional(),
        content: skillContentSchema.optional(),
      }),
      await readJsonBody(c),
    );
    const skill = await run(async () =>
      updateCloudSkill(await ctxFrom(c, body.projectId), {
        skillId: body.skillId,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
      }),
    );
    return { success: true, skill };
  }),
);

skills.post("/delete", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(skillIdSchema, await readJsonBody(c));
    await run(async () =>
      deleteCloudSkill(await ctxFrom(c, body.projectId), body.skillId),
    );
    return { success: true };
  }),
);

skills.post("/promote", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(skillIdSchema, await readJsonBody(c));
    const skill = await run(async () =>
      promoteCloudSkill(await ctxFrom(c, body.projectId), body.skillId),
    );
    return { success: true, skill };
  }),
);

// ── supporting files (v2) ──────────────────────────────────────────────────

skills.post("/files/list", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(skillIdSchema, await readJsonBody(c));
    const files = await run(async () =>
      listCloudSkillFiles(await ctxFrom(c, body.projectId), body.skillId),
    );
    return { files };
  }),
);

// Mint a browser→Convex direct upload URL (blob bypasses the inspector body
// limit by design). The manage-gate runs in Convex before the URL is issued.
skills.post("/files/upload-url", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(skillIdSchema, await readJsonBody(c));
    const { uploadUrl } = await run(async () =>
      generateCloudSkillFileUploadUrl(
        await ctxFrom(c, body.projectId),
        body.skillId,
      ),
    );
    return { uploadUrl };
  }),
);

skills.post("/files/attach", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      skillIdSchema.extend({
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              storageId: z.string().min(1),
              contentHash: z.string().min(1),
            }),
          )
          .min(1),
      }),
      await readJsonBody(c),
    );
    const { files } = await run(async () =>
      attachCloudSkillFiles(
        await ctxFrom(c, body.projectId),
        body.skillId,
        body.files,
      ),
    );
    return { files };
  }),
);

skills.post("/files/remove", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      skillIdSchema.extend({ path: z.string().min(1) }),
      await readJsonBody(c),
    );
    const { removed } = await run(async () =>
      removeCloudSkillFile(
        await ctxFrom(c, body.projectId),
        body.skillId,
        body.path,
      ),
    );
    return { success: true, removed };
  }),
);

// Read a file's content: resolves the storage URL + fetches bytes SERVER-SIDE
// (the browser never sees the storage URL), returning a SkillFileContent.
skills.post("/files/read", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      skillIdSchema.extend({ path: z.string().min(1) }),
      await readJsonBody(c),
    );
    const file = await run(async () =>
      readCloudSkillFile(
        await ctxFrom(c, body.projectId),
        body.skillId,
        body.path,
      ),
    );
    return { file };
  }),
);

export default skills;
