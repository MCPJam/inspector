/**
 * Public v1 Project Environment surface: CRUD + archive/restore + launch
 * resolution over a project's named execution bundles.
 *
 * A Project Environment is a live-editable, project-scoped bundle that eval
 * suites and journeys run against: one host, an optional standalone server
 * group, an optional pinned skill selection, and optional pinned plugin
 * versions. It is NOT a Computer sandbox image (see ./images.ts, which owns
 * `/projects/:projectId/images` and still calls the Convex
 * `computerEnvironments:*` module) and NOT the eval-suite `environment`
 * servers bag.
 *
 * These routes are thin proxies over the same Convex `projectEnvironments:*`
 * functions the hosted UI uses, called with the request's Convex bearer. Every
 * one of those functions takes the path's `projectId` and scopes to it inside
 * Convex, so a valid id from another of the caller's projects reads as
 * NOT_FOUND — there is no route-side ownership preflight.
 *
 * Two contracts the public surface must not smooth over:
 *
 *  1. OPTIMISTIC CONCURRENCY. Every mutation takes the `expectedRevision` the
 *     caller last read. The route REQUIRES it in the body rather than
 *     re-reading the current revision server-side: silently supplying the
 *     current value would turn the backend's safe concurrent-edit rejection
 *     into a last-write-wins clobber. A stale value is a 409.
 *
 *  2. CLEAR-VS-UNCHANGED. On PATCH, an omitted field is left unchanged and an
 *     explicit `null` CLEARS it. Empty arrays are rejected by the backend on
 *     purpose ("clear the selection instead"), so `[]` is a 400, not a clear.
 *
 * Reads require project membership; every write requires project ADMIN, since
 * an environment is shared mutable execution config. An `sk_` key acts as the
 * user it is bound to, so a non-admin's key gets 403 on writes.
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
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";

const environments = new Hono();

// ── Convex row shapes (hand-mirrored from convex/projectEnvironments.ts) ─────
type SkillSelection = { mode: "explicit"; skillIds: string[] };

type EnvironmentRow = {
  environmentId: string;
  projectId: string;
  name: string;
  description?: string;
  hostId: string;
  serverAttachmentId?: string;
  skillSelection?: SkillSelection;
  pluginVersionIds?: string[];
  revision: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type ResolvedEnvironmentRow = {
  environmentRef: { environmentId: string; name: string; revision: number };
  hostId: string;
  hostName: string;
  hostConfigId: string;
  serverAttachmentId?: string;
  selectedServerIds: string[];
  effectiveServerIds: string[];
  pluginVersions: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash: string;
  }>;
  servers: Array<{ serverId: string; name: string }>;
};

// ── Public DTO mappers (clean `id`; no Convex `environmentId` leak) ──────────
function toEnvironmentDto(row: EnvironmentRow) {
  return {
    id: row.environmentId,
    projectId: row.projectId,
    name: row.name,
    ...(row.description !== undefined ? { description: row.description } : {}),
    hostId: row.hostId,
    ...(row.serverAttachmentId !== undefined
      ? { serverAttachmentId: row.serverAttachmentId }
      : {}),
    ...(row.skillSelection !== undefined
      ? { skillSelection: row.skillSelection }
      : {}),
    ...(row.pluginVersionIds !== undefined
      ? { pluginVersionIds: row.pluginVersionIds }
      : {}),
    revision: row.revision,
    // Presence is the live/archived signal; `archived` is derived so callers
    // don't have to know that.
    archived: row.archivedAt !== undefined,
    ...(row.archivedAt !== undefined ? { archivedAt: row.archivedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toResolvedDto(resolved: ResolvedEnvironmentRow) {
  return {
    environment: {
      id: resolved.environmentRef.environmentId,
      name: resolved.environmentRef.name,
      revision: resolved.environmentRef.revision,
    },
    hostId: resolved.hostId,
    hostName: resolved.hostName,
    hostConfigId: resolved.hostConfigId,
    ...(resolved.serverAttachmentId !== undefined
      ? { serverAttachmentId: resolved.serverAttachmentId }
      : {}),
    selectedServerIds: resolved.selectedServerIds ?? [],
    effectiveServerIds: resolved.effectiveServerIds ?? [],
    pluginVersions: resolved.pluginVersions ?? [],
    servers: resolved.servers ?? [],
  };
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

/** The structured payload a Convex `ConvexError` carries on `.data`. */
type ConvexErrorData = {
  code?: string;
  message?: string;
  details?: Record<string, string>;
};

function convexErrorData(error: unknown): ConvexErrorData | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as ConvexErrorData;
}

/**
 * Launch-resolution failures (`resolveEnvironmentForLaunch`). The environment
 * exists and the caller may read it, but it cannot currently produce a runnable
 * configuration — a pinned plugin was disabled, the host was deleted, the
 * closed server set came out empty. That is a 409 (state conflict), not bad
 * input, and the machine-readable `code` rides along in `details` so callers
 * can branch without parsing prose.
 */
const RESOLVE_NOT_FOUND_CODES = new Set(["ENV_NOT_FOUND", "ENV_CROSS_PROJECT"]);

function translateResolveError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (code && code.startsWith("ENV_")) {
    const message =
      typeof data?.message === "string" ? data.message : "Environment error";
    if (RESOLVE_NOT_FOUND_CODES.has(code)) {
      return new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Environment not found"
      );
    }
    return new WebRouteError(409, ErrorCode.CONFLICT, message, {
      code,
      ...(data?.details ?? {}),
    });
  }
  return translateConvexError(error, "Environment could not be resolved");
}

/**
 * CRUD failures. The backend throws structured `ConvexError` data with a
 * `code`, so branch on that first and fall back to message sniffing only for
 * errors raised outside the module's own `fail()` helper.
 *
 * FORBIDDEN is deliberately split. "Not a project member" becomes 404 so the
 * surface never confirms that a project id exists to someone outside it; the
 * admin gate becomes a true 403, because the caller demonstrably CAN see the
 * project and needs to know the block is their role, not a bad id.
 */
function translateConvexError(
  error: unknown,
  fallbackMessage = "Environment write rejected by the platform"
): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  const structuredMessage =
    typeof data?.message === "string" ? data.message : undefined;

  if (code === "CONFLICT") {
    return new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      structuredMessage ?? "Environment changed since you loaded it."
    );
  }
  if (code === "VALIDATION") {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      structuredMessage ?? fallbackMessage
    );
  }
  if (code === "NOT_FOUND") {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Environment not found");
  }
  if (code === "FORBIDDEN") {
    if (structuredMessage && /admin/i.test(structuredMessage)) {
      return new WebRouteError(403, ErrorCode.FORBIDDEN, structuredMessage);
    }
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Environment or project not found, or you do not have access to it."
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/not found|unauthorized|not a member/i.test(message)) {
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Environment or project not found, or you do not have access to it."
    );
  }
  // Infrastructure failures (timeouts, connection resets) are 5xx, not a 400
  // validation error — defer to the shared runtime classifier so a transient
  // outage isn't reported to callers as bad input.
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
    cleaned || fallbackMessage
  );
}

/**
 * Parse the body as a JSON object (or `{}` when empty). Unlike
 * `synthesizeServerBody`, it does NOT merge path params in, so a strict schema
 * sees only the caller's fields and rejects unknown keys. `projectId` and
 * `environmentId` always come from the path, never the body.
 */
async function readJsonObjectBody(
  c: Context
): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be a JSON object"
    );
  }
  return parsed as Record<string, unknown>;
}

async function readEnvironment(
  convexAuthToken: string,
  projectId: string,
  environmentId: string
): Promise<EnvironmentRow> {
  const readClient = createConvexClient(convexAuthToken);
  let row: EnvironmentRow | null;
  try {
    // `projectEnvironments:getEnvironment` enforces project scope from
    // `projectId`: an id from another of the caller's projects throws NOT_FOUND.
    row = (await readClient.query(
      "projectEnvironments:getEnvironment" as any,
      { projectId, environmentId } as any
    )) as EnvironmentRow | null;
  } catch (error) {
    throw translateConvexError(error);
  }
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Environment not found");
  }
  return row;
}

// ── Schemas ─────────────────────────────────────────────────────────────────
// Strict: unknown keys are a 400, not silently dropped, so a public-API typo
// (`pluginVersions` for `pluginVersionIds`) fails loudly instead of creating an
// environment that quietly pins nothing.

/**
 * Mirrors the backend envelope exactly. `skillIds` is `.min(1)` because the
 * backend rejects an empty explicit selection — "no skills" is expressed by
 * clearing the field (`null`), not by an empty list.
 */
const skillSelectionSchema = z.strictObject({
  mode: z.literal("explicit"),
  skillIds: z.array(z.string().trim().min(1)).min(1),
});

const pluginVersionIdsSchema = z.array(z.string().trim().min(1)).min(1);

const createEnvironmentSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  hostId: z.string().trim().min(1),
  serverAttachmentId: z.string().trim().min(1).optional(),
  skillSelection: skillSelectionSchema.optional(),
  pluginVersionIds: pluginVersionIdsSchema.optional(),
});

/**
 * `.nullable().optional()` on the three clearable fields encodes the backend's
 * tri-state: omitted = unchanged, `null` = clear, value = set.
 */
const updateEnvironmentSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    hostId: z.string().trim().min(1).optional(),
    serverAttachmentId: z.string().trim().min(1).nullable().optional(),
    skillSelection: skillSelectionSchema.nullable().optional(),
    pluginVersionIds: pluginVersionIdsSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.hostId !== undefined ||
      value.serverAttachmentId !== undefined ||
      value.skillSelection !== undefined ||
      value.pluginVersionIds !== undefined,
    {
      message:
        "Provide at least one of `name`, `description`, `hostId`, `serverAttachmentId`, `skillSelection`, or `pluginVersionIds` to update.",
    }
  );

/** Archive and restore carry only the precondition. */
const revisionBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
});

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/environments — list a project's environments.
// Archived rows are excluded unless `?includeArchived=true`; without it there
// is no way to find an archived environment to restore.
environments.get("/projects/:projectId/environments", async (c) => {
  const projectId = c.req.param("projectId");
  const includeArchived = c.req.query("includeArchived") === "true";
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let rows: EnvironmentRow[] | null | undefined;
  try {
    rows = (await readClient.query(
      "projectEnvironments:listEnvironments" as any,
      { projectId, includeArchived } as any
    )) as EnvironmentRow[] | null | undefined;
  } catch (error) {
    throw translateConvexError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toEnvironmentDto));
});

// GET /v1/projects/:projectId/environments/:environmentId
environments.get(
  "/projects/:projectId/environments/:environmentId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const token = await getConvexBearerForRequest(c);
    return v1Resource(
      c,
      toEnvironmentDto(await readEnvironment(token, projectId, environmentId))
    );
  }
);

// GET /v1/projects/:projectId/environments/:environmentId/resolve
// The launch preview: what this environment resolves to right now (host config,
// closed server set, pinned plugin versions). Read-only and member-gated — the
// same resolution an eval run performs, exposed so an external runner can
// connect the exact server set before launching.
environments.get(
  "/projects/:projectId/environments/:environmentId/resolve",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const readClient = createConvexClient(await getConvexBearerForRequest(c));
    let resolved: ResolvedEnvironmentRow | null;
    try {
      resolved = (await readClient.query(
        "projectEnvironments:resolveEnvironmentForLaunch" as any,
        { projectId, environmentId } as any
      )) as ResolvedEnvironmentRow | null;
    } catch (error) {
      throw translateResolveError(error);
    }
    if (!resolved || !resolved.environmentRef) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Environment not found"
      );
    }
    return v1Resource(c, toResolvedDto(resolved));
  }
);

// POST /v1/projects/:projectId/environments — create. Requires project admin.
environments.post("/projects/:projectId/environments", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(
    createEnvironmentSchema,
    await readJsonObjectBody(c)
  );
  const token = await getConvexBearerForRequest(c);
  const convexClient = createConvexClient(token);

  let created: EnvironmentRow;
  try {
    created = (await convexClient.mutation(
      "projectEnvironments:createEnvironment" as any,
      { projectId, ...body } as any
    )) as EnvironmentRow;
  } catch (error) {
    throw translateConvexError(error);
  }
  return v1Resource(c, toEnvironmentDto(created), 201);
});

// PATCH /v1/projects/:projectId/environments/:environmentId
// `expectedRevision` is required; a stale value is a 409 rather than a
// silent overwrite of a concurrent edit.
environments.patch(
  "/projects/:projectId/environments/:environmentId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const body = parseWithSchema(
      updateEnvironmentSchema,
      await readJsonObjectBody(c)
    );
    const token = await getConvexBearerForRequest(c);

    // Sparse args: an omitted field must stay ABSENT (unchanged), while an
    // explicit `null` must be forwarded (clear). `!== undefined` preserves
    // that distinction; a truthiness check would collapse both.
    const updateArgs: Record<string, unknown> = {
      projectId,
      environmentId,
      expectedRevision: body.expectedRevision,
    };
    if (body.name !== undefined) updateArgs.name = body.name;
    if (body.description !== undefined)
      updateArgs.description = body.description;
    if (body.hostId !== undefined) updateArgs.hostId = body.hostId;
    if (body.serverAttachmentId !== undefined)
      updateArgs.serverAttachmentId = body.serverAttachmentId;
    if (body.skillSelection !== undefined)
      updateArgs.skillSelection = body.skillSelection;
    if (body.pluginVersionIds !== undefined)
      updateArgs.pluginVersionIds = body.pluginVersionIds;

    const convexClient = createConvexClient(token);
    let updated: EnvironmentRow;
    try {
      updated = (await convexClient.mutation(
        "projectEnvironments:updateEnvironment" as any,
        updateArgs as any
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexError(error);
    }
    return v1Resource(c, toEnvironmentDto(updated));
  }
);

// POST /v1/projects/:projectId/environments/:environmentId/archive
// Modelled as an explicit sub-action rather than DELETE: the backend keeps the
// row and restore has real semantics, so DELETE would misdescribe both.
environments.post(
  "/projects/:projectId/environments/:environmentId/archive",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const body = parseWithSchema(
      revisionBodySchema,
      await readJsonObjectBody(c)
    );
    const convexClient = createConvexClient(await getConvexBearerForRequest(c));
    let archived: EnvironmentRow;
    try {
      archived = (await convexClient.mutation(
        "projectEnvironments:archiveEnvironment" as any,
        {
          projectId,
          environmentId,
          expectedRevision: body.expectedRevision,
        } as any
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexError(error);
    }
    return v1Resource(c, toEnvironmentDto(archived));
  }
);

// POST /v1/projects/:projectId/environments/:environmentId/restore
// Restore re-checks the name against live rows (409 if taken while archived)
// and drops plugin pins whose version rows no longer exist at all. Compare the
// returned `pluginVersionIds` against what you archived to detect that.
environments.post(
  "/projects/:projectId/environments/:environmentId/restore",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const body = parseWithSchema(
      revisionBodySchema,
      await readJsonObjectBody(c)
    );
    const convexClient = createConvexClient(await getConvexBearerForRequest(c));
    let restored: EnvironmentRow;
    try {
      restored = (await convexClient.mutation(
        "projectEnvironments:restoreEnvironment" as any,
        {
          projectId,
          environmentId,
          expectedRevision: body.expectedRevision,
        } as any
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexError(error);
    }
    return v1Resource(c, toEnvironmentDto(restored));
  }
);

export default environments;
