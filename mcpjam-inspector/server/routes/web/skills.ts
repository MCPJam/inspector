/**
 * Cloud Skills — hosted/`/web` routes. The horizontally-scaled counterpart of
 * the local filesystem skills routes (`routes/mcp/skills.ts`). Every operation
 * runs against the caller's **Computer** (E2B sandbox) via
 * `utils/computers/cloud-skills.ts`; there is no local FS in hosted mode.
 *
 * Auth: bearer end-to-end (forwarded to Convex for reserve/wake + authz, which
 * only ever resolves the (project, user) computer of the bearer's owner). The
 * `projectId` in each request body selects which computer. Mirrors
 * `routes/web/computers.ts`.
 */
import { Hono } from "hono";
import { z } from "zod";
import "../../types/hono"; // Type extensions
import {
  ErrorCode,
  WebRouteError,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  assertBearerToken,
} from "./auth.js";
import {
  CloudSkillsError,
  listCloudSkills,
  getCloudSkill,
  uploadCloudSkill,
  uploadCloudSkillFolder,
  deleteCloudSkill,
  listCloudSkillFiles,
  readCloudSkillFile,
  type CloudSkillsContext,
  type CloudSkillUploadFile,
} from "../../utils/computers/cloud-skills.js";

const skills = new Hono();

/** Map a service-layer status to the closest web ErrorCode. */
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
    case 502:
      return ErrorCode.SERVER_UNREACHABLE;
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
      throw new WebRouteError(err.status, codeForStatus(err.status), err.message);
    }
    throw err;
  }
}

function ctxFrom(c: any, projectId: string): CloudSkillsContext {
  return {
    authHeader: `Bearer ${assertBearerToken(c)}`,
    projectId,
    signal: c.req.raw.signal,
  };
}

const projectOnly = z.object({ projectId: z.string().min(1) });
const nameSchema = projectOnly.extend({ name: z.string().min(1) });

skills.post("/list", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(projectOnly, await readJsonBody(c));
    const list = await run(() => listCloudSkills(ctxFrom(c, body.projectId)));
    return { skills: list };
  }),
);

skills.post("/get", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(nameSchema, await readJsonBody(c));
    const skill = await run(() =>
      getCloudSkill(ctxFrom(c, body.projectId), body.name),
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

skills.post("/upload", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      projectOnly.extend({
        name: z.string().min(1),
        description: z.string().min(1),
        content: z.string().min(1),
      }),
      await readJsonBody(c),
    );
    const skill = await run(() =>
      uploadCloudSkill(ctxFrom(c, body.projectId), {
        name: body.name,
        description: body.description,
        content: body.content,
      }),
    );
    return { success: true, skill };
  }),
);

skills.post("/upload-folder", async (c) =>
  handleRoute(c, async () => {
    const formData = await c.req.formData();
    const projectId = formData.get("projectId");
    const skillName = formData.get("skillName");
    const rawFiles = formData.getAll("files") as File[];

    if (typeof projectId !== "string" || !projectId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required",
      );
    }
    if (typeof skillName !== "string" || !skillName) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "skillName is required",
      );
    }
    if (!rawFiles || rawFiles.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "No files uploaded",
      );
    }

    const files: CloudSkillUploadFile[] = await Promise.all(
      rawFiles.map(async (f) => ({
        path: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    );

    const skill = await run(() =>
      uploadCloudSkillFolder(ctxFrom(c, projectId), skillName, files),
    );
    return { success: true, skill };
  }),
);

skills.post("/delete", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(nameSchema, await readJsonBody(c));
    const deleted = await run(() =>
      deleteCloudSkill(ctxFrom(c, body.projectId), body.name),
    );
    if (!deleted) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Skill '${body.name}' not found`,
      );
    }
    return { success: true };
  }),
);

skills.post("/files", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(nameSchema, await readJsonBody(c));
    const files = await run(() =>
      listCloudSkillFiles(ctxFrom(c, body.projectId), body.name),
    );
    return { files };
  }),
);

skills.post("/read-file", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      nameSchema.extend({ filePath: z.string().min(1) }),
      await readJsonBody(c),
    );
    const file = await run(() =>
      readCloudSkillFile(ctxFrom(c, body.projectId), body.name, body.filePath),
    );
    return { file };
  }),
);

export default skills;
