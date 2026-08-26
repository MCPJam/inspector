/**
 * Public v1 host surface: CRUD over a project's MCP hosts.
 *
 * Hosts are project-scoped identity rows that point at a content-addressed
 * host config (model + capabilities + host context). These routes are thin
 * proxies over the same Convex `hosts:*` functions the hosted UI uses, called
 * with the request's Convex bearer (Convex enforces project membership). The
 * detail/update/delete `hosts:*` functions take the path's projectId and scope
 * the host to it inside Convex, so a valid id from another of the caller's
 * projects reads as NOT_FOUND.
 *
 * `create` seeds the host config two ways: from a built-in template
 * (resolved from the live backend host catalog, falling back to the bundled SDK
 * catalog snapshot) or from a full host config body.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import {
  bundledHostCompatCatalog,
  fetchHostCompatCatalog,
  getCatalogTemplate,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { logger } from "../../utils/logger.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError as translateConvexError } from "./convex-errors.js";
import { readJsonObjectBody } from "./adapter.js";

const hosts = new Hono();
const HOST_CATALOG_FETCH_TIMEOUT_MS = 6_500;

// ── Convex row shapes (mirrored from client/src/hooks/useClients.ts) ────────
type HostListRow = {
  hostId: string;
  name: string;
  hostConfigId: string;
  modelId: string;
  serverCount: number;
  createdAt: number;
  updatedAt: number;
};

type HostDetailRow = {
  hostId: string;
  name: string;
  config: Record<string, unknown>;
};

// ── Public DTO mappers (clean names; no Convex `hostId` leak) ────────────────
function toHostDto(row: HostListRow) {
  return {
    id: row.hostId,
    name: row.name,
    hostConfigId: row.hostConfigId,
    modelId: row.modelId,
    serverCount: row.serverCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toHostDetailDto(detail: HostDetailRow) {
  return { id: detail.hostId, name: detail.name, config: detail.config };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function warnHostTemplateFallback(details: Record<string, unknown>): void {
  logger.warn("[host-catalog] v1 host template fallback", details);
}

async function fetchBackendHostCatalog(): Promise<HostCompatCatalog | null> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    warnHostTemplateFallback({ reason: "missing_convex_http_url" });
    return null;
  }
  const baseUrl = new URL("/public", convexHttpUrl).toString();
  const result = await fetchHostCompatCatalog({
    baseUrl,
    timeoutMs: HOST_CATALOG_FETCH_TIMEOUT_MS,
  });
  if (!result.ok) {
    warnHostTemplateFallback({ reason: result.reason });
    return null;
  }
  return result.catalog;
}

async function resolveHostTemplateInput(
  templateId: string,
  theme: "light" | "dark" | undefined
): Promise<Record<string, unknown>> {
  const liveCatalog = await fetchBackendHostCatalog();
  const template =
    (liveCatalog ? getCatalogTemplate(liveCatalog, templateId) : undefined) ??
    getCatalogTemplate(bundledHostCompatCatalog(), templateId);
  if (!template) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Unknown host template: ${templateId}`
    );
  }

  const input = cloneJson(template) as Record<string, unknown>;
  // The forward-client invariant applies to the template branch too. Templates
  // carry their OWN model (each is tuned to the client it emulates), so this is
  // a guard, never a substitution — a catalog entry that lost its model is a
  // catalog bug, and minting a modelless host from it would surface as an
  // `ENV_MODEL_REQUIRED` launch refusal much later.
  if (!hostConfigPinsAModel(input)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Host template "${templateId}" does not pin a model; pass an explicit \`config\` instead.`
    );
  }
  if (theme !== undefined) {
    const hostContext =
      input.hostContext &&
      typeof input.hostContext === "object" &&
      !Array.isArray(input.hostContext)
        ? (input.hostContext as Record<string, unknown>)
        : {};
    input.hostContext = { ...hostContext, theme };
  }
  return input;
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

function translateConvexWriteError(error: unknown): WebRouteError {
  return translateConvexError(error, {
    resource: "Host",
    // Convex collapses "project missing", "not a project member", and "host
    // missing" into the same generic error, and the v1 surface deliberately
    // doesn't leak which. Keep the message neutral rather than asserting
    // "Host not found" — the failure on the list/create paths is usually the
    // PROJECT (bad id or no membership), where a host-specific message misleads.
    notFoundMessage:
      "Project or host not found, or you do not have access to it.",
    fallbackMessage: "Host write rejected by the platform",
  });
}

async function readHostDetail(
  convexAuthToken: string,
  projectId: string,
  hostId: string
): Promise<HostDetailRow> {
  const readClient = createConvexClient(convexAuthToken);
  let detail: HostDetailRow | null;
  try {
    // Convex `hosts:getHost` enforces project scope: passing `projectId` means
    // a host id from another of the caller's projects returns null (→ 404
    // below) instead of leaking across projects.
    detail = (await readClient.query(
      "hosts:getHost" as any,
      {
        hostId,
        projectId,
      } as any
    )) as HostDetailRow | null;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  if (!detail) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Host not found");
  }
  return detail;
}

// ── Schemas ─────────────────────────────────────────────────────────────────
const hostConfigSchema = z.record(z.string(), z.unknown());

/**
 * FORWARD-CLIENT INVARIANT: a host created through this route must pin a
 * model.
 *
 * An environment resolves its execution model from its own override, else from
 * the host it selects, else nowhere — and "nowhere" is a hard launch refusal
 * (`ENV_MODEL_REQUIRED`). A host minted with `modelId: ""` is therefore a host
 * that cannot back a headless environment, and the failure would surface at
 * launch rather than at creation.
 *
 * Deliberately a REFINEMENT over the passthrough record rather than a full
 * config schema: every other config field stays untyped here on purpose (the
 * authoritative validator is `ensureHostConfigV2` in the backend), and this
 * route should not acquire a second copy of it that can drift. Legacy rows with
 * an empty model are untouched — they still read, and unrelated edits still
 * apply; only NEW hosts are held to the invariant.
 *
 * Applied in the outer `superRefine` rather than on the field, so the XOR
 * message still wins for a degenerate `config: {}` — that body's real problem
 * is that it picked neither branch, not that it forgot a model.
 */
function hostConfigPinsAModel(config: Record<string, unknown>): boolean {
  return typeof config.modelId === "string" && config.modelId.trim().length > 0;
}

/**
 * Return `config` with `modelId` TRIMMED.
 *
 * The rest of the config is passed through opaquely, but the model cannot be:
 * it is stored verbatim and compared verbatim downstream, so a padded
 * `" anthropic/claude-sonnet-4-5 "` would be persisted as a distinct — and
 * unrecognized — model id. Trimming matches the environment contract's
 * `normalizeModelId`, which is the other write boundary this value reaches.
 * Only ever a trim; the id itself is never rewritten.
 */
function withTrimmedModelId(
  config: Record<string, unknown>
): Record<string, unknown> {
  return typeof config.modelId === "string"
    ? { ...config, modelId: config.modelId.trim() }
    : config;
}

const createHostSchema = z
  .strictObject({
    name: z.string().trim().min(1),
    template: z.string().trim().min(1).optional(),
    theme: z.enum(["light", "dark"]).optional(),
    config: hostConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // An empty `{}` is a truthy object but not a usable host config; count
    // config only when it actually carries fields so `--json '{}'` can't
    // satisfy the XOR and mint a degenerate host.
    const hasConfig =
      value.config !== undefined && Object.keys(value.config).length > 0;
    if ((value.template ? 1 : 0) + (hasConfig ? 1 : 0) !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of `template` or a non-empty `config`.",
      });
      return;
    }
    if (hasConfig && !hostConfigPinsAModel(value.config!)) {
      ctx.addIssue({
        code: "custom",
        path: ["config", "modelId"],
        message:
          '`config.modelId` is required and must be a non-empty model id (e.g. "anthropic/claude-sonnet-4-5").',
      });
    }
  });

const updateHostSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    config: hostConfigSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: "Provide at least one of `name` or `config` to update.",
  });

const updateHostServersSchema = z.strictObject({
  serverIds: z.array(z.string().trim().min(1)),
  optionalServerIds: z.array(z.string().trim().min(1)).optional(),
});

const duplicateHostSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
});

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/hosts — list a project's hosts.
hosts.get("/projects/:projectId/hosts", async (c) => {
  const projectId = c.req.param("projectId");
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let rows: HostListRow[] | null | undefined;
  try {
    rows = (await readClient.query(
      "hosts:listHosts" as any,
      {
        projectId,
      } as any
    )) as HostListRow[] | null | undefined;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toHostDto));
});

// GET /v1/projects/:projectId/hosts/:hostId — full host detail + config.
hosts.get("/projects/:projectId/hosts/:hostId", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  const token = await getConvexBearerForRequest(c);
  return v1Resource(
    c,
    toHostDetailDto(await readHostDetail(token, projectId, hostId))
  );
});

// POST /v1/projects/:projectId/hosts — create from a template or a full config.
hosts.post("/projects/:projectId/hosts", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(createHostSchema, await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);
  const convexClient = createConvexClient(token);

  // Trim on BOTH branches: the normalization belongs to the write boundary, not
  // to one of the two ways of reaching it. A template is authored data too, and
  // one carrying a padded `modelId` would otherwise persist an id that no
  // downstream verbatim comparison recognizes.
  const input = withTrimmedModelId(
    body.template
      ? await resolveHostTemplateInput(body.template, body.theme)
      : body.config!
  );

  let created: { hostId: string };
  try {
    created = (await convexClient.mutation(
      "hosts:createHost" as any,
      {
        projectId,
        name: body.name,
        input,
      } as any
    )) as { hostId: string };
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(
    c,
    toHostDetailDto(await readHostDetail(token, projectId, created.hostId)),
    201
  );
});

// PATCH /v1/projects/:projectId/hosts/:hostId — rename and/or replace config.
hosts.patch("/projects/:projectId/hosts/:hostId", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  const body = parseWithSchema(updateHostSchema, await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);

  // `hosts:updateHost` enforces project scope from `projectId` (a host from
  // another project throws not-found → 404), so there is no separate preflight
  // for AUTHORIZATION. A config write needs the current row for a different
  // reason — see below.
  const updateArgs: Record<string, unknown> = { hostId, projectId };
  if (body.name !== undefined) updateArgs.name = body.name;
  if (body.config !== undefined) {
    // A config PATCH REPLACES the config, so it is the one write on this route
    // that can strip the model off an existing host — the forward-client
    // invariant that `create` enforces would otherwise be one PATCH wide open.
    // Same rule as the Behavior tab: CLEARING a pinned model is refused, while
    // a legacy modelless host stays editable for everything else. That needs
    // the pre-edit model, so the read happens only on the branch that needs it.
    const current = await readHostDetail(token, projectId, hostId);
    if (
      hostConfigPinsAModel(current.config) &&
      !hostConfigPinsAModel(body.config)
    ) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "`config.modelId` is required and must be a non-empty model id: this host pins a model, and clearing it would leave it unable to back a headless environment.",
        { modelId: current.config.modelId }
      );
    }
    updateArgs.input = withTrimmedModelId(body.config);
  }
  const convexClient = createConvexClient(token);
  try {
    await convexClient.mutation("hosts:updateHost" as any, updateArgs);
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(
    c,
    toHostDetailDto(await readHostDetail(token, projectId, hostId))
  );
});

// POST /v1/projects/:projectId/hosts/:hostId/servers — replace the host's
// required and optional saved-server attachments without round-tripping the
// full host config through the client.
hosts.post("/projects/:projectId/hosts/:hostId/servers", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  const body = parseWithSchema(
    updateHostServersSchema,
    await readJsonObjectBody(c)
  );
  const token = await getConvexBearerForRequest(c);
  const convexClient = createConvexClient(token);
  try {
    await convexClient.mutation("hosts:updateHostServers" as any, {
      projectId,
      hostId,
      serverIds: body.serverIds,
      optionalServerIds: body.optionalServerIds,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(
    c,
    toHostDetailDto(await readHostDetail(token, projectId, hostId))
  );
});

// POST /v1/projects/:projectId/hosts/:hostId/duplicate — duplicate a host's
// immutable config and return the newly-created host detail.
hosts.post("/projects/:projectId/hosts/:hostId/duplicate", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  const body = parseWithSchema(
    duplicateHostSchema,
    await readJsonObjectBody(c)
  );
  const token = await getConvexBearerForRequest(c);
  const convexClient = createConvexClient(token);

  // Duplication MINTS a host, so it is held to the same forward-client
  // invariant as `create`. Copying a legacy modelless row is the one way this
  // route could keep producing the state `create` now refuses — and unlike an
  // edit to a legacy row, nothing is stranded by refusing: the source still
  // exists, and pinning its model makes the copy legal.
  const source = await readHostDetail(token, projectId, hostId);
  if (!hostConfigPinsAModel(source.config)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Host "${source.name}" does not pin a model, so duplicating it would create another host that cannot back a headless environment. Pin a model on it first.`
    );
  }

  let created: { hostId: string };
  try {
    created = (await convexClient.mutation("hosts:duplicateHost" as any, {
      projectId,
      hostId,
      ...(body.name === undefined ? {} : { name: body.name }),
    })) as { hostId: string };
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(
    c,
    toHostDetailDto(await readHostDetail(token, projectId, created.hostId)),
    201
  );
});

// DELETE /v1/projects/:projectId/hosts/:hostId
hosts.delete("/projects/:projectId/hosts/:hostId", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  // Delete takes no body. Parse the caller's JSON (no synthesized path
  // params) against a strict empty object so a leftover `force` — or a
  // stray `projectId` — is a VALIDATION_ERROR that names the key.
  parseWithSchema(z.strictObject({}), await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);
  // `hosts:deleteHost` enforces project scope from `projectId`.
  const convexClient = createConvexClient(token);
  try {
    await convexClient.mutation("hosts:deleteHost" as any, {
      hostId,
      projectId,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, { id: hostId, deleted: true });
});

export default hosts;
