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
 * Reads require project membership. EDITING an existing environment (patch,
 * archive, restore) requires project ADMIN, since that changes execution config
 * other people's suites already run. CREATING one does not: `create`,
 * `ensure-adhoc`, and `name` are member-gated, because every surface a member
 * composes a setup from is member-reachable and an admin gate would fail them
 * at launch after the work was done. Pinning plugin versions escalates to ADMIN
 * on both create paths. An `sk_` key acts as the user it is bound to, so a
 * non-admin's key gets 403 on the admin writes.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { readJsonObjectBody } from "./adapter.js";

const environments = new Hono();

// ── Convex row shapes (hand-mirrored from convex/projectEnvironments.ts) ─────
type SkillSelection = {
  mode: "explicit";
  skillIds: string[];
  /** Optional exact authored-skill revisions; absent means Latest at launch. */
  versionPins?: Array<{ skillId: string; versionId: string }>;
};

/**
 * A row this API is willing to emit.
 *
 * Mirrors the client's `environmentOrigin`: trust `origin` when the backend
 * sends it, and fall back to name-presence when it doesn't, so a deployment
 * that predates the split reads every row as named — which they all are.
 */
function isNamedEnvironmentRow(row: {
  name?: string;
  origin?: "named" | "adhoc";
}): boolean {
  if (row.origin === "named") return true;
  if (row.origin === "adhoc") return false;
  return typeof row.name === "string" && row.name.trim().length > 0;
}

type EnvironmentRow = {
  environmentId: string;
  projectId: string;
  /** Absent on ad-hoc rows, which `/v1` never emits — see `isNamedEnvironmentRow`. */
  name?: string;
  /** Absent from a backend that predates the named/ad-hoc split ⇒ named. */
  origin?: "named" | "adhoc";
  description?: string;
  hostId: string;
  serverAttachmentId?: string;
  /** The stored model OVERRIDE. Absent ⇒ the environment inherits its host's. */
  modelId?: string;
  skillSelection?: SkillSelection;
  pluginVersionIds?: string[];
  /** Internal (Convex) name for the sandbox-image pin — public DTOs expose it
   *  as `sandboxImageId`, matching the SDK's `PlatformImage` vocabulary. */
  computerEnvironmentId?: string;
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
  /** The stored override, when the environment sets one. */
  modelId?: string;
  /**
   * The model this environment WILL RUN. Optional in the wire type only for
   * deploy skew — a backend that predates the feature omits it. A launch
   * resolution from a current backend always carries it, because an
   * environment with no model is refused with `ENV_MODEL_REQUIRED` rather than
   * resolved.
   */
  effectiveModelId?: string;
  modelSource?: "environment" | "host";
  serverAttachmentId?: string;
  /** Optional for deploy skew: present once the backend resolve carries the
   *  env-level sandbox-image pin through. */
  computerEnvironmentId?: string;
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
    // The STORED override only. `effectiveModelId` is a resolution result and
    // lives on the resolve DTO — conflating them here would leave a caller
    // unable to tell "pinned to X" from "inheriting X", which is exactly the
    // distinction an editor needs.
    ...(row.modelId !== undefined ? { modelId: row.modelId } : {}),
    ...(row.skillSelection !== undefined
      ? { skillSelection: row.skillSelection }
      : {}),
    ...(row.pluginVersionIds !== undefined
      ? { pluginVersionIds: row.pluginVersionIds }
      : {}),
    // Public name: `sandboxImageId` (a `PlatformImage` / `mcpjam images` id).
    // The internal Convex field keeps its historical name; the rename lives
    // ONLY at this DTO boundary and its inverse in the write handlers.
    ...(row.computerEnvironmentId !== undefined
      ? { sandboxImageId: row.computerEnvironmentId }
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

/**
 * An AD-HOC row, which the rest of this surface deliberately never emits.
 *
 * A separate mapper rather than a flag on `toEnvironmentDto`, because the two
 * shapes make DIFFERENT promises. `PlatformEnvironment.name` is a required
 * string, and every listing here filters ad-hoc rows out precisely so that
 * promise holds. An ad-hoc row has no name at all, so it gets a shape that
 * says so — `name: null` plus `adhoc: true` — instead of quietly widening a
 * published type and breaking readers who trusted it.
 */
function toAdhocEnvironmentDto(row: EnvironmentRow) {
  return {
    ...toEnvironmentDto(row),
    // EXPLICIT, not absent: a caller has to be able to tell "unnamed by
    // construction" from "the platform forgot to send a name".
    name: null,
    adhoc: true,
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
    ...(resolved.modelId !== undefined ? { modelId: resolved.modelId } : {}),
    ...(resolved.effectiveModelId !== undefined
      ? { effectiveModelId: resolved.effectiveModelId }
      : {}),
    ...(resolved.modelSource !== undefined
      ? { modelSource: resolved.modelSource }
      : {}),
    ...(resolved.serverAttachmentId !== undefined
      ? { serverAttachmentId: resolved.serverAttachmentId }
      : {}),
    ...(resolved.computerEnvironmentId !== undefined
      ? { sandboxImageId: resolved.computerEnvironmentId }
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
      "Server missing CONVEX_URL configuration",
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

/**
 * True when a Convex call failed because the DEPLOYMENT does not export the
 * function — the one failure the capability probe is allowed to read as
 * "unsupported".
 *
 * Matched on the message because Convex surfaces this as a plain client error
 * with no structured code: there is nothing more precise to key on. Kept
 * deliberately narrow so an authorization or transport failure cannot be
 * mistaken for deploy skew.
 */
function isMissingConvexFunctionError(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown } | null)?.message ?? error ?? "",
  ).toLowerCase();
  return (
    message.includes("could not find public function") ||
    message.includes("could not find function") ||
    message.includes("function not found")
  );
}

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

/**
 * Stable `details.reason` slugs for the ENV_* codes a caller is expected to
 * BRANCH on rather than merely display.
 *
 * `ENV_MODEL_REQUIRED` is the one that matters today: the environment sets no
 * model and the client it uses has none pinned, so it cannot launch at all.
 * That is remediable — pick a model on one of the two — and a caller (the CLI,
 * an external runner, the composer) needs to distinguish it from the other
 * transient resolution failures without pattern-matching prose.
 */
const RESOLVE_REASON_BY_CODE: Record<string, string> = {
  ENV_MODEL_REQUIRED: "environment_model_required",
};

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
        "Environment not found",
      );
    }
    const reason = RESOLVE_REASON_BY_CODE[code];
    return new WebRouteError(409, ErrorCode.CONFLICT, message, {
      code,
      ...(data?.details ?? {}),
      ...(reason ? { reason } : {}),
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
  fallbackMessage = "Environment write rejected by the platform",
): WebRouteError {
  return translateConvexWriteError(error, {
    resource: "Environment",
    fallbackMessage,
    // "Not a project member" must read the same as "no such project"; only the
    // admin gate below is allowed to be specific.
    notFoundMessage:
      "Environment or project not found, or you do not have access to it.",
    conflictMessage: "Environment changed since you loaded it.",
    // The caller demonstrably CAN see the environment, so telling them the
    // block is their role rather than a bad id reveals nothing new.
    adminFailureIsForbidden: true,
  });
}

async function readEnvironment(
  convexAuthToken: string,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentRow> {
  const readClient = createConvexClient(convexAuthToken);
  let row: EnvironmentRow | null;
  try {
    // `projectEnvironments:getEnvironment` enforces project scope from
    // `projectId`: an id from another of the caller's projects throws NOT_FOUND.
    row = (await readClient.query(
      "projectEnvironments:getEnvironment" as any,
      { projectId, environmentId } as any,
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
 * clearing the field (`null`), not by an empty list. `versionPins` is an
 * optional overlay: selected skills without a pin track Latest at launch.
 */
const skillSelectionSchema = z.strictObject({
  mode: z.literal("explicit"),
  skillIds: z.array(z.string().trim().min(1)).min(1),
  versionPins: z
    .array(
      z.strictObject({
        skillId: z.string().trim().min(1),
        versionId: z.string().trim().min(1),
      }),
    )
    .min(1)
    .optional(),
});

const pluginVersionIdsSchema = z.array(z.string().trim().min(1)).min(1);

const createEnvironmentSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  hostId: z.string().trim().min(1),
  serverAttachmentId: z.string().trim().min(1).optional(),
  /**
   * Model OVERRIDE. Omit to inherit the host's pinned model. `.min(1)` after
   * trimming, matching the backend: an empty string is not a way to spell "no
   * model" — on PATCH that is `null`, and on create it is simply omission.
   */
  modelId: z.string().trim().min(1).optional(),
  skillSelection: skillSelectionSchema.optional(),
  pluginVersionIds: pluginVersionIdsSchema.optional(),
  /** Public name for the internal `computerEnvironmentId` pin; must be a
   *  project-shared image (backend rejects personal drafts). */
  sandboxImageId: z.string().trim().min(1).optional(),
});

/**
 * `.nullable().optional()` on every clearable field (`serverAttachmentId`,
 * `skillSelection`, `pluginVersionIds`, `sandboxImageId`) encodes the backend's
 * tri-state: omitted = unchanged, `null` = clear, value = set. A new clearable
 * field must join BOTH that shape and the `.refine` below, or it silently
 * becomes unclearable / unable to be the only field in a PATCH.
 */
const updateEnvironmentSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    hostId: z.string().trim().min(1).optional(),
    serverAttachmentId: z.string().trim().min(1).nullable().optional(),
    modelId: z.string().trim().min(1).nullable().optional(),
    skillSelection: skillSelectionSchema.nullable().optional(),
    pluginVersionIds: pluginVersionIdsSchema.nullable().optional(),
    sandboxImageId: z.string().trim().min(1).nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.hostId !== undefined ||
      value.serverAttachmentId !== undefined ||
      value.modelId !== undefined ||
      value.skillSelection !== undefined ||
      value.pluginVersionIds !== undefined ||
      value.sandboxImageId !== undefined,
    {
      message:
        "Provide at least one of `name`, `description`, `hostId`, `serverAttachmentId`, `modelId`, `skillSelection`, `pluginVersionIds`, or `sandboxImageId` to update.",
    },
  );

/**
 * A COMPOSED stack: the same execution axes a named environment carries, minus
 * the name. Content-addressed server-side, so the same stack always resolves
 * to the same row.
 *
 * Deliberately the create schema's field set: an ad-hoc environment IS an
 * environment, and a second vocabulary for the same axes is how the two
 * descriptions drift.
 */
const ensureAdhocEnvironmentSchema = z.strictObject({
  hostId: z.string().trim().min(1),
  serverAttachmentId: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
  skillSelection: skillSelectionSchema.optional(),
  pluginVersionIds: pluginVersionIdsSchema.optional(),
  sandboxImageId: z.string().trim().min(1).optional(),
});

/**
 * Promotion of an ad-hoc row to a named one. `expectedRevision` for the same
 * reason every other mutation takes it: supplying the current value
 * server-side would turn a safe concurrent-edit rejection into a clobber.
 */
const nameEnvironmentSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().trim().min(1),
  description: z.string().optional(),
});

/** Archive and restore carry only the precondition. */
const revisionBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
});

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/environments/capabilities
//
// What THIS deployment's environment surface accepts. Exists for version skew,
// not feature flagging: the Inspector, the SDK and the CLI ship independently
// of the backend, and a newer client must not send a `modelId` an older
// deployment's validator would reject with an unreadable error.
//
// ABSENCE IS THE SIGNAL. An older backend does not export `getCapabilities`,
// the proxied query fails, and this route answers `false` for everything —
// which is exactly what a client should assume when it cannot ask. So the
// failure is swallowed on purpose rather than surfaced: a 500 here would break
// clients that are perfectly able to fall back.
//
// Registered ABOVE `/:environmentId` so the literal segment is not captured as
// an environment id.
environments.get(
  "/projects/:projectId/environments/capabilities",
  async (c) => {
    const projectId = c.req.param("projectId");
    const readClient = createConvexClient(await getConvexBearerForRequest(c));
    let capabilities: {
      modelOverrides?: boolean;
      modelMatrix?: boolean;
      ephemeralEnvironmentLaunch?: boolean;
      skillVersionPins?: boolean;
    } = {};
    try {
      capabilities =
        ((await readClient.query(
          "projectEnvironments:getCapabilities" as any,
          { projectId } as any,
        )) as typeof capabilities | null) ?? {};
    } catch (error) {
      // ONLY deploy skew is swallowed. An older backend does not export this
      // function, so the call fails with a "could not find function" error and
      // `false` is the correct answer.
      //
      // Everything else must surface. Collapsing an authorization failure, a
      // missing project, or an upstream outage into a cheerful 200 with both
      // capabilities false tells the caller "this platform is too old" — which
      // is not merely unhelpful but wrong, and sends them to upgrade something
      // that is already current instead of fixing their access.
      if (!isMissingConvexFunctionError(error)) {
        throw translateConvexError(
          error,
          "Environment capabilities could not be read",
        );
      }
      capabilities = {};
    }
    return v1Resource(c, {
      modelOverrides: capabilities.modelOverrides === true,
      modelMatrix: capabilities.modelMatrix === true,
      ephemeralEnvironmentLaunch:
        capabilities.ephemeralEnvironmentLaunch === true,
      skillVersionPins: capabilities.skillVersionPins === true,
    });
  },
);

// GET /v1/projects/:projectId/environments — list a project's environments.
// Archived rows are excluded unless `?includeArchived=true`; without it there
// is no way to find an archived environment to restore.
//
// AD-HOC rows are excluded unconditionally — not even opt-in. `/v1` is the
// NAMED-environments API: `PlatformEnvironment.name` is a required field in the
// published SDK type, so emitting a nameless DTO here would be a breaking
// change for every external consumer. Ad-hoc rows are an internal
// run-provenance concept; the browser surfaces read them through Convex.
//
// The backend's own default is already named-only, so this filter is belt and
// braces against a backend that widens that default later.
environments.get("/projects/:projectId/environments", async (c) => {
  const projectId = c.req.param("projectId");
  const includeArchived = c.req.query("includeArchived") === "true";
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let rows: EnvironmentRow[] | null | undefined;
  try {
    rows = (await readClient.query(
      "projectEnvironments:listEnvironments" as any,
      { projectId, includeArchived } as any,
    )) as EnvironmentRow[] | null | undefined;
  } catch (error) {
    throw translateConvexError(error);
  }
  return v1PageJson(
    c,
    (rows ?? []).filter(isNamedEnvironmentRow).map(toEnvironmentDto),
  );
});

// GET /v1/projects/:projectId/environments/:environmentId
environments.get(
  "/projects/:projectId/environments/:environmentId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const token = await getConvexBearerForRequest(c);
    const row = await readEnvironment(token, projectId, environmentId);
    return v1Resource(
      c,
      isNamedEnvironmentRow(row)
        ? toEnvironmentDto(row)
        : toAdhocEnvironmentDto(row),
    );
  },
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
        { projectId, environmentId } as any,
      )) as ResolvedEnvironmentRow | null;
    } catch (error) {
      throw translateResolveError(error);
    }
    if (!resolved || !resolved.environmentRef) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Environment not found",
      );
    }
    return v1Resource(c, toResolvedDto(resolved));
  },
);

// POST /v1/projects/:projectId/environments — create. Requires project admin.
environments.post("/projects/:projectId/environments", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(
    createEnvironmentSchema,
    await readJsonObjectBody(c),
  );
  const token = await getConvexBearerForRequest(c);
  const convexClient = createConvexClient(token);

  // Rename at the boundary: the public `sandboxImageId` becomes the internal
  // `computerEnvironmentId` — the spread must not forward the public name.
  const { sandboxImageId, ...createRest } = body;
  let created: EnvironmentRow;
  try {
    created = (await convexClient.mutation(
      "projectEnvironments:createEnvironment" as any,
      {
        projectId,
        ...createRest,
        ...(sandboxImageId !== undefined
          ? { computerEnvironmentId: sandboxImageId }
          : {}),
      } as any,
    )) as EnvironmentRow;
  } catch (error) {
    throw translateConvexError(error);
  }
  return v1Resource(c, toEnvironmentDto(created), 201);
});

// POST /v1/projects/:projectId/environments/ensure-adhoc
//
// GET-OR-CREATE an UNNAMED, content-addressed environment for a composed
// stack — the same thing the app's environment composer produces when a user
// assembles a client/model/computer/skills combination instead of picking a
// saved environment.
//
// WHY NOT `POST /environments`. That mints a NAMED row, which lands in the
// project's environment list forever. A composed stack is a throwaway: the
// caller wants to run this exact combination, not to add a permanent entry
// someone else has to reason about. Ad-hoc rows exist to avoid exactly that
// pollution, and until now the only way to reach them was the browser hook.
//
// Deduped by a SERVER-SIDE fingerprint, so the same stack always returns the
// same environment (`created: false` on every call after the first) and a
// retried launch converges instead of accumulating rows.
//
// Registered ABOVE `/:environmentId` so the literal segment is not captured as
// an environment id.
environments.post(
  "/projects/:projectId/environments/ensure-adhoc",
  async (c) => {
    const projectId = c.req.param("projectId");
    const body = parseWithSchema(
      ensureAdhocEnvironmentSchema,
      await readJsonObjectBody(c),
    );
    const convexClient = createConvexClient(await getConvexBearerForRequest(c));

    // Same boundary rename as create: the public `sandboxImageId` is the
    // internal `computerEnvironmentId`, and the spread must not forward the
    // public name.
    const { sandboxImageId, ...stack } = body;
    let result: { environment: EnvironmentRow; created: boolean };
    try {
      result = (await convexClient.mutation(
        "projectEnvironments:ensureAdhocEnvironment" as any,
        {
          projectId,
          ...stack,
          ...(sandboxImageId !== undefined
            ? { computerEnvironmentId: sandboxImageId }
            : {}),
        } as any,
      )) as { environment: EnvironmentRow; created: boolean };
    } catch (error) {
      // DEPLOY SKEW, translated rather than surfaced as a 500: a backend that
      // predates ad-hoc environments simply does not export this function, and
      // the honest answer names the alternative the caller does have.
      if (isMissingConvexFunctionError(error)) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "This deployment predates ad-hoc environments — create a named environment instead (POST /environments).",
          { reason: "ADHOC_UNAVAILABLE" },
        );
      }
      throw translateConvexError(error);
    }

    // 200, not 201: this is get-or-create, and the caller learns which
    // happened from `created` rather than from the status line. A 201 on the
    // dedupe path would claim a row was minted when none was.
    return v1Resource(c, {
      environment: toAdhocEnvironmentDto(result.environment),
      created: result.created === true,
    });
  },
);

// POST /v1/projects/:projectId/environments/:environmentId/name
//
// PROMOTE an ad-hoc row to a named environment, in place.
//
// This is the ONLY promotion path: `PATCH /environments/:id` cannot do it. The
// backend's rename is admin-gated and refuses a row that already has a name;
// promotion is member-gated and refuses a row that already has one. Routing
// promotion through PATCH would either open the admin rename to members or
// leave ad-hoc rows unnameable — the backend keeps them apart on purpose, and
// so does this.
//
// Promotion also CLEARS the content fingerprint, because a named row is
// mutable: keeping it would let a later composition dedupe onto a row that has
// since been edited into something else.
environments.post(
  "/projects/:projectId/environments/:environmentId/name",
  async (c) => {
    const projectId = c.req.param("projectId");
    const environmentId = c.req.param("environmentId");
    const body = parseWithSchema(
      nameEnvironmentSchema,
      await readJsonObjectBody(c),
    );
    const convexClient = createConvexClient(await getConvexBearerForRequest(c));
    let named: EnvironmentRow;
    try {
      named = (await convexClient.mutation(
        "projectEnvironments:nameEnvironment" as any,
        {
          projectId,
          environmentId,
          expectedRevision: body.expectedRevision,
          name: body.name,
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
        } as any,
      )) as EnvironmentRow;
    } catch (error) {
      if (isMissingConvexFunctionError(error)) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "This deployment predates ad-hoc environments, so there is nothing to promote.",
          { reason: "ADHOC_UNAVAILABLE" },
        );
      }
      // An already-named row comes back as the backend's CONFLICT, which is
      // the honest answer: the request asked to promote something that is not
      // promotable, and renaming a named environment is a different (and
      // admin-gated) operation.
      throw translateConvexError(error);
    }
    return v1Resource(c, toEnvironmentDto(named));
  },
);

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
      await readJsonObjectBody(c),
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
    // Tri-state, like every other clearable: `null` CLEARS the override (fall
    // back to the host's model), a value replaces it, omission preserves it.
    if (body.modelId !== undefined) updateArgs.modelId = body.modelId;
    if (body.skillSelection !== undefined)
      updateArgs.skillSelection = body.skillSelection;
    if (body.pluginVersionIds !== undefined)
      updateArgs.pluginVersionIds = body.pluginVersionIds;
    // Boundary rename (public sandboxImageId ↔ internal computerEnvironmentId);
    // `null` forwards as null (clear), omitted stays absent (unchanged).
    if (body.sandboxImageId !== undefined)
      updateArgs.computerEnvironmentId = body.sandboxImageId;

    const convexClient = createConvexClient(token);
    let updated: EnvironmentRow;
    try {
      updated = (await convexClient.mutation(
        "projectEnvironments:updateEnvironment" as any,
        updateArgs as any,
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexError(error);
    }
    return v1Resource(c, toEnvironmentDto(updated));
  },
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
      await readJsonObjectBody(c),
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
        } as any,
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexError(error);
    }
    return v1Resource(c, toEnvironmentDto(archived));
  },
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
      await readJsonObjectBody(c),
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
        } as any,
      )) as EnvironmentRow;
    } catch (error) {
      throw translateConvexError(error);
    }
    return v1Resource(c, toEnvironmentDto(restored));
  },
);

export default environments;
