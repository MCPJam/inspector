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
  MAX_SKILL_CONTENT_BYTES,
  type CloudSkillsContext,
} from "../../utils/computers/cloud-skills.js";

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
        content: z.string().min(1).max(MAX_SKILL_CONTENT_BYTES),
        sharing: sharingSchema,
      }),
      await readJsonBody(c),
    );
    const skill = await run(async () =>
      createCloudSkill(await ctxFrom(c, body.projectId), {
        name: body.name,
        description: body.description,
        content: body.content,
        ...(body.sharing ? { sharing: body.sharing } : {}),
      }),
    );
    return { success: true, skill };
  }),
);

skills.post("/update", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      skillIdSchema.extend({
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        content: z.string().min(1).max(MAX_SKILL_CONTENT_BYTES).optional(),
      }),
      await readJsonBody(c),
    );
    const skill = await run(async () =>
      updateCloudSkill(await ctxFrom(c, body.projectId), {
        skillId: body.skillId,
        ...(body.name !== undefined ? { name: body.name } : {}),
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

export default skills;
