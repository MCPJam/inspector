/**
 * Public v1 computer-environments surface: CRUD + build + attach over a
 * project's custom Computer images (a digest-pinned Dockerfile built into an
 * immutable E2B image a member's Computer can boot from).
 *
 * Thin proxies over the same Convex `computerEnvironments:*` / `projectComputers:*`
 * functions the hosted UI uses, called with the request's Convex bearer.
 *
 * SCOPE NOTE: unlike `hosts:*` (which take the path projectId and scope inside
 * Convex), the env mutations `update/build/promote/delete/builds` take ONLY an
 * `environmentId` and authorize by the ENV's own project. So this surface must
 * itself prove the env belongs to the URL's `:projectId` before mutating —
 * otherwise a caller with access to projects A and B could mutate B's env via an
 * A-scoped URL. `readEnvironmentInProject` is that guard (404 on mismatch).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import {
  parseWithSchema,
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
} from "../web/errors.js";
import { createConvexClients } from "../shared/evals.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { synthesizeServerBody } from "./adapter.js";

const environments = new Hono();

// ── Convex row shapes (mirror client/src/hooks/useComputerEnvironments.ts) ────
type BuildRow = {
  buildId: string;
  status: "queued" | "building" | "ready" | "failed";
  provider: "e2b" | "stub";
  e2bBuildId?: string;
  baseImageDigests: string[];
  logPreview?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
};

type EnvironmentRow = {
  environmentId: string;
  projectId: string;
  name: string;
  dockerfile: string;
  contentHash: string;
  sharing: "user" | "project";
  isOwner: boolean;
  currentBuildId?: string;
  currentBuild: BuildRow | null;
  createdAt: number;
  updatedAt: number;
};

// ── Public DTO mappers (clean `id`; no raw `environmentId`/`buildId` leak) ─────
function toBuildDto(row: BuildRow) {
  return {
    id: row.buildId,
    status: row.status,
    provider: row.provider,
    e2bBuildId: row.e2bBuildId,
    baseImageDigests: row.baseImageDigests,
    logPreview: row.logPreview,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toEnvironmentDto(row: EnvironmentRow) {
  return {
    id: row.environmentId,
    projectId: row.projectId,
    name: row.name,
    dockerfile: row.dockerfile,
    contentHash: row.contentHash,
    sharing: row.sharing,
    isOwner: row.isOwner,
    currentBuild: row.currentBuild ? toBuildDto(row.currentBuild) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function createConvexReadClient(convexAuthToken: string): ConvexHttpClient {
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

function translateConvexWriteError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|unauthorized|not a member|cannot manage|admin/i.test(message)) {
    // Convex collapses "project missing", "not a member", "env missing", and
    // the shared-env admin gate into generic errors; keep the v1 message
    // neutral rather than leaking which.
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Environment or project not found, or you do not have access to it."
    );
  }
  // Infrastructure failures (timeouts, connection resets) are 5xx, not a 400
  // validation error — defer to the shared runtime classifier (504/502/…) so
  // a transient outage isn't reported to callers as bad input.
  if (
    /timed out|timeout|fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(
      message
    )
  ) {
    return mapRuntimeError(error);
  }
  const cleaned = message
    .replace(/\[Request ID:[^\]]*\]\s*/g, "")
    .replace(/^Server Error\s*/i, "")
    .replace(/Uncaught (Error|ConvexError):\s*/i, "")
    .split("\n")[0]!
    .trim();
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    cleaned || "Environment write rejected by the platform"
  );
}

/**
 * The project-scope guard. Fetch the env by id and confirm it belongs to the
 * URL's project; a mismatch (or a missing env) reads as 404 — never leaking
 * that the id exists in another of the caller's projects. Returns the env so
 * callers reuse it as the response/precondition.
 */
async function readEnvironmentInProject(
  convexAuthToken: string,
  projectId: string,
  environmentId: string
): Promise<EnvironmentRow> {
  const readClient = createConvexReadClient(convexAuthToken);
  let env: EnvironmentRow | null;
  try {
    env = (await readClient.query("computerEnvironments:getEnvironment" as any, {
      environmentId,
    } as any)) as EnvironmentRow | null;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  if (!env || env.projectId !== projectId) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Environment not found in this project"
    );
  }
  return env;
}

/**
 * Enforce a truly bodyless action: reject ANY field (a stray `environmentId`,
 * a legacy flag, …) as VALIDATION_ERROR rather than silently dropping it.
 * Mirrors the hosts DELETE contract.
 */
async function assertEmptyBody(c: Context) {
  const raw = await c.req.text();
  if (!raw.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be a JSON object"
    );
  }
  const stray = Object.keys(parsed).sort();
  if (stray.length > 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Unexpected field(s) in body: ${stray.join(", ")}`
    );
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────
const createEnvironmentSchema = z.object({
  name: z.string().trim().min(1),
  dockerfile: z.string().min(1),
});

const updateEnvironmentSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    dockerfile: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.dockerfile !== undefined,
    { message: "Provide at least one of `name` or `dockerfile` to update." }
  );

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/computer-environments — list a project's environments.
environments.get("/projects/:projectId/computer-environments", async (c) => {
  const projectId = c.req.param("projectId");
  const readClient = createConvexReadClient(await getConvexBearerForRequest(c));
  let rows: EnvironmentRow[] | null | undefined;
  try {
    rows = (await readClient.query(
      "computerEnvironments:listEnvironments" as any,
      { projectId } as any
    )) as EnvironmentRow[] | null | undefined;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toEnvironmentDto));
});

// POST /v1/projects/:projectId/computer-environments — create.
environments.post("/projects/:projectId/computer-environments", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(
    createEnvironmentSchema,
    await synthesizeServerBody(c)
  );
  const token = await getConvexBearerForRequest(c);
  const { convexClient } = createConvexClients(token);
  let created: EnvironmentRow;
  try {
    created = (await convexClient.mutation(
      "computerEnvironments:createEnvironment" as any,
      { projectId, name: body.name, dockerfile: body.dockerfile } as any
    )) as EnvironmentRow;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, toEnvironmentDto(created), 201);
});

// GET /v1/projects/:projectId/computer-environments/:environmentId — detail.
environments.get(
  "/projects/:projectId/computer-environments/:environmentId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const token = await getConvexBearerForRequest(c);
    const env = await readEnvironmentInProject(token, projectId, environmentId);
    return v1Resource(c, toEnvironmentDto(env));
  }
);

// PATCH /v1/projects/:projectId/computer-environments/:environmentId — rename / edit Dockerfile.
environments.patch(
  "/projects/:projectId/computer-environments/:environmentId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const body = parseWithSchema(
      updateEnvironmentSchema,
      await synthesizeServerBody(c)
    );
    const token = await getConvexBearerForRequest(c);
    // Scope guard: env must belong to this project before we mutate by id.
    await readEnvironmentInProject(token, projectId, environmentId);
    const updateArgs: Record<string, unknown> = { environmentId };
    if (body.name !== undefined) updateArgs.name = body.name;
    if (body.dockerfile !== undefined) updateArgs.dockerfile = body.dockerfile;
    const { convexClient } = createConvexClients(token);
    let updated: EnvironmentRow;
    try {
      updated = (await convexClient.mutation(
        "computerEnvironments:updateEnvironment" as any,
        updateArgs as any
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    return v1Resource(c, toEnvironmentDto(updated));
  }
);

// DELETE /v1/projects/:projectId/computer-environments/:environmentId
environments.delete(
  "/projects/:projectId/computer-environments/:environmentId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    await assertEmptyBody(c);
    const token = await getConvexBearerForRequest(c);
    await readEnvironmentInProject(token, projectId, environmentId);
    const { convexClient } = createConvexClients(token);
    try {
      await convexClient.mutation(
        "computerEnvironments:deleteEnvironment" as any,
        { environmentId } as any
      );
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    return v1Resource(c, { id: environmentId, deleted: true });
  }
);

// GET /v1/projects/:projectId/computer-environments/:environmentId/builds
environments.get(
  "/projects/:projectId/computer-environments/:environmentId/builds",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const token = await getConvexBearerForRequest(c);
    await readEnvironmentInProject(token, projectId, environmentId);
    const readClient = createConvexReadClient(token);
    let rows: BuildRow[] | null | undefined;
    try {
      rows = (await readClient.query(
        "computerEnvironments:listEnvironmentBuilds" as any,
        { environmentId } as any
      )) as BuildRow[] | null | undefined;
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    return v1PageJson(c, (rows ?? []).map(toBuildDto));
  }
);

// POST /v1/projects/:projectId/computer-environments/:environmentId/build — trigger a build.
environments.post(
  "/projects/:projectId/computer-environments/:environmentId/build",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    await assertEmptyBody(c);
    const token = await getConvexBearerForRequest(c);
    await readEnvironmentInProject(token, projectId, environmentId);
    const { convexClient } = createConvexClients(token);
    let result: { buildId: string; reused: boolean };
    try {
      result = (await convexClient.mutation(
        "computerEnvironments:startEnvironmentBuild" as any,
        { environmentId } as any
      )) as { buildId: string; reused: boolean };
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    // 202: the build runs asynchronously; poll the builds list for status.
    return v1Resource(
      c,
      { id: environmentId, buildId: result.buildId, reused: result.reused },
      202
    );
  }
);

// POST /v1/projects/:projectId/computer-environments/:environmentId/promote — share to project.
environments.post(
  "/projects/:projectId/computer-environments/:environmentId/promote",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    await assertEmptyBody(c);
    const token = await getConvexBearerForRequest(c);
    await readEnvironmentInProject(token, projectId, environmentId);
    const { convexClient } = createConvexClients(token);
    let promoted: EnvironmentRow;
    try {
      promoted = (await convexClient.mutation(
        "computerEnvironments:promoteEnvironmentToProject" as any,
        { environmentId } as any
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    return v1Resource(c, toEnvironmentDto(promoted));
  }
);

// POST /v1/projects/:projectId/computer-environments/:environmentId/use — attach to the caller's computer.
environments.post(
  "/projects/:projectId/computer-environments/:environmentId/use",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    await assertEmptyBody(c);
    const token = await getConvexBearerForRequest(c);
    await readEnvironmentInProject(token, projectId, environmentId);
    const { convexClient } = createConvexClients(token);
    let computer: { computerId: string; status: string };
    try {
      computer = (await convexClient.mutation(
        "projectComputers:setComputerEnvironment" as any,
        { projectId, environmentId } as any
      )) as { computerId: string; status: string };
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    return v1Resource(c, {
      environmentId,
      computerId: computer.computerId,
      status: computer.status,
    });
  }
);

// POST /v1/projects/:projectId/computer/reset — reset the caller's computer to its image.
environments.post("/projects/:projectId/computer/reset", async (c) => {
  const projectId = c.req.param("projectId");
  await assertEmptyBody(c);
  const token = await getConvexBearerForRequest(c);
  const { convexClient } = createConvexClients(token);
  let result: { reset: boolean };
  try {
    result = (await convexClient.mutation(
      "projectComputers:resetComputer" as any,
      { projectId } as any
    )) as { reset: boolean };
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, { projectId, reset: result.reset });
});

export default environments;
