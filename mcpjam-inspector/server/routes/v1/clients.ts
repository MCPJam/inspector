/**
 * Public v1 CLIENT surface: CRUD over a project's MCP clients.
 *
 * A **Client** is the product noun — "a named, reusable configuration that
 * defines how MCPJam connects to and talks to your MCP servers". Underneath it
 * is a project-scoped identity row pointing at an immutable, content-addressed
 * config. These routes are thin proxies over the same Convex `hosts:*`
 * functions the hosted UI uses, called with the request's Convex bearer (Convex
 * enforces project membership). The detail/update/delete `hosts:*` functions
 * take the path's projectId and scope the client to it inside Convex, so a
 * valid id from another of the caller's projects reads as NOT_FOUND.
 *
 * `create` seeds the config two ways: from a built-in template (resolved from
 * the live backend host catalog, falling back to the bundled SDK catalog
 * snapshot) or from a full config body.
 *
 * ── Two surfaces, one implementation ────────────────────────────────────────
 *
 * Everything is registered TWICE: canonically under `/clients`, and under the
 * original `/hosts` paths as a deprecated compatibility alias. The alias is not
 * a redirect and not a type alias — it is the same handler with a different DTO
 * mapper, because the two surfaces genuinely differ:
 *
 *   - `/clients` emits `configId` and carries the read-backs an editor needs
 *     (`ownerScope`, `hasComputer`, timestamps, `impact`).
 *   - `/hosts` emits `hostConfigId` and keeps exactly the shape it always had.
 *
 * Collapsing them into one mapper with a renamed key would silently change the
 * deprecated surface's runtime shape for every existing caller, which is the
 * one thing a compatibility alias must not do.
 *
 * The canonical surface is also STRICTER, deliberately: every config-affecting
 * write requires `expectedConfigId` and every rename requires `expectedName`.
 * The aliases keep today's lenient contract — a compatibility surface that
 * starts rejecting requests it used to accept is a break wearing a deprecation
 * notice.
 *
 * NAMING: `hostStyle`, `/host-catalog` and `clientCapabilities`/`clientInfo`
 * inside a config are NOT this concept. The first two are the AI-host
 * compatibility catalog; the last two are the MCP-protocol client. None of them
 * are renamed here, and nothing inside the opaque config blob is touched.
 */
import { Hono } from "hono";
import type { Context } from "hono";
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

const clients = new Hono();
const HOST_CATALOG_FETCH_TIMEOUT_MS = 6_500;

// ── Convex row shapes (mirrored from client/src/hooks/useClients.ts) ────────
type HostListRow = {
  hostId: string;
  name: string;
  hostConfigId: string;
  modelId: string;
  serverCount: number;
  ownerScope?: { type?: string } | null;
  hasComputer?: boolean;
  createdAt: number;
  updatedAt: number;
};

/** The three durable consumer counts a config edit follows. */
type HostImpact = {
  liveEnvironmentCount: number;
  scenarioAttachmentCount: number;
  activeLegacyJourneyCount: number;
};

type HostDetailRow = {
  hostId: string;
  name: string;
  config: Record<string, unknown>;
  // Everything below arrives from a backend at or past the read-back change.
  // Typed optional so a canonical route running against an older deployment
  // degrades to the fields it does have rather than emitting `null` tokens a
  // caller would then echo back as a precondition.
  hostConfigId?: string;
  ownerScope?: { type?: string } | null;
  hasComputer?: boolean;
  createdAt?: number;
  updatedAt?: number;
  impact?: HostImpact;
};

/**
 * True for a client row that exists only as the private backing of ONE User
 * Testing scenario.
 *
 * Mirrors `isPrivateScenarioBackingHost` (`client/src/lib/host-owner-scope.ts`)
 * — the same predicate every generic client picker in the app applies. These
 * rows are reachable by name, so filtering them at the LIST route only would
 * leave the detail route as a way to read one by guessing its scenario's name.
 * Both routes share this, and so does the backend resolver.
 */
function isPrivateBacking(row: {
  ownerScope?: { type?: string } | null;
}): boolean {
  return row.ownerScope?.type === "user_testing";
}

// ── Public DTO mappers ──────────────────────────────────────────────────────
//
// Two pairs, canonical and legacy. See the module header for why this is not
// one mapper with a renamed key.

function toClientDto(row: HostListRow) {
  return {
    id: row.hostId,
    name: row.name,
    configId: row.hostConfigId,
    modelId: row.modelId,
    serverCount: row.serverCount,
    ownerScope: row.ownerScope ?? null,
    hasComputer: row.hasComputer ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The `/hosts` alias projection — exactly the shape that surface always had. */
function toLegacyHostDto(row: HostListRow) {
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

function toClientDetailDto(detail: HostDetailRow) {
  return {
    id: detail.hostId,
    name: detail.name,
    // The concurrency token. Content-addressed, so same-id ⇔ byte-identical
    // config: echoing it back as `expectedConfigId` names exactly the config an
    // edit was composed against.
    ...(detail.hostConfigId === undefined
      ? {}
      : { configId: detail.hostConfigId }),
    config: detail.config,
    ownerScope: detail.ownerScope ?? null,
    ...(detail.hasComputer === undefined
      ? {}
      : { hasComputer: detail.hasComputer }),
    ...(detail.createdAt === undefined ? {} : { createdAt: detail.createdAt }),
    ...(detail.updatedAt === undefined ? {} : { updatedAt: detail.updatedAt }),
    // What a config edit would follow. Quoted verbatim by the agent approval
    // card, and preconditionable via `expectedImpact`.
    ...(detail.impact === undefined ? {} : { impact: detail.impact }),
  };
}

/** The `/hosts` alias detail projection — id, name, config, and nothing else. */
function toLegacyHostDetailDto(detail: HostDetailRow) {
  return { id: detail.hostId, name: detail.name, config: detail.config };
}

/**
 * Mark an alias response as deprecated on the wire (RFC 8594).
 *
 * On the response rather than in the body: a body field would only reach
 * callers who parse for it, while the header reaches every proxy, log and
 * client library that already looks.
 */
function markDeprecated(c: Context): void {
  c.header("Deprecation", "true");
  c.header(
    "Link",
    '</api/v1/projects/{projectId}/clients>; rel="successor-version"'
  );
}

/**
 * Read a path segment as the string it always is.
 *
 * These handlers are plain functions rather than inline route callbacks (one
 * implementation, two registrations), so Hono can no longer infer the path's
 * declared params and types every one as `string | undefined`. The router only
 * ever dispatches them on paths that declare every segment read here.
 */
function pathParam(c: Context, name: string): string {
  return c.req.param(name) as string;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function warnHostTemplateFallback(details: Record<string, unknown>): void {
  logger.warn("[host-catalog] v1 client template fallback", details);
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
      `Unknown client template: ${templateId}`
    );
  }

  const input = cloneJson(template) as Record<string, unknown>;
  // The forward-client invariant applies to the template branch too. Templates
  // carry their OWN model (each is tuned to the client it emulates), so this is
  // a guard, never a substitution — a catalog entry that lost its model is a
  // catalog bug, and minting a modelless client from it would surface as an
  // `ENV_MODEL_REQUIRED` launch refusal much later.
  if (!hostConfigPinsAModel(input)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Client template "${templateId}" does not pin a model; pass an explicit \`config\` instead.`
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
    resource: "Client",
    // Convex collapses "project missing", "not a project member", and "client
    // missing" into the same generic error, and the v1 surface deliberately
    // doesn't leak which. Keep the message neutral rather than asserting
    // "Client not found" — the failure on the list/create paths is usually the
    // PROJECT (bad id or no membership), where a client-specific message
    // misleads.
    notFoundMessage:
      "Project or client not found, or you do not have access to it.",
    fallbackMessage: "Client write rejected by the platform",
  });
}

async function listHostRows(
  convexAuthToken: string,
  projectId: string
): Promise<HostListRow[]> {
  const readClient = createConvexClient(convexAuthToken);
  try {
    return ((await readClient.query(
      "hosts:listHosts" as any,
      { projectId } as any
    )) ?? []) as HostListRow[];
  } catch (error) {
    throw translateConvexWriteError(error);
  }
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
    // a client id from another of the caller's projects returns null (→ 404
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
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Client not found");
  }
  return detail;
}

/**
 * Does this failure mean the backend has no such Convex function?
 *
 * Narrow ON PURPOSE. Treating any error from `resolveHostByNameOrId` as skew
 * would swallow an authorization refusal, an ambiguity error, and every
 * ordinary backend failure into a list-and-scan that answers a different
 * question — including, for the ambiguity case, silently picking one of two
 * clients. Only a genuinely absent function falls back.
 */
function isMissingConvexFunction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /could not find (public )?function/i.test(message) ||
    /function not found/i.test(message)
  );
}

/**
 * Resolve a `:client` path segment — a client ID **or** a client name.
 *
 * Delegates to Convex `hosts:resolveHostByNameOrId`, which owns the eligibility
 * rule so the resolver, this route and the list filter cannot disagree about
 * whether a private User Testing backing row is a candidate. The list-and-scan
 * below is the version-skew fallback for a backend that predates that function,
 * and it applies the IDENTICAL filter and uniqueness rule for the same reason.
 */
async function resolveClientId(
  convexAuthToken: string,
  projectId: string,
  selector: string,
  includePrivateBacking: boolean
): Promise<string> {
  const readClient = createConvexClient(convexAuthToken);
  try {
    const resolved = (await readClient.query(
      "hosts:resolveHostByNameOrId" as any,
      { projectId, selector, includePrivateBacking } as any
    )) as { hostId: string } | null;
    if (resolved?.hostId) return resolved.hostId;
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Client not found");
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    if (!isMissingConvexFunction(error)) throw translateConvexWriteError(error);
  }

  const rows = (await listHostRows(convexAuthToken, projectId)).filter(
    (row) => includePrivateBacking || !isPrivateBacking(row)
  );
  const byId = rows.find((row) => row.hostId === selector);
  if (byId) return byId.hostId;
  const needle = selector.trim().toLocaleLowerCase();
  const matches = rows.filter(
    (row) => row.name.trim().toLocaleLowerCase() === needle
  );
  if (matches.length === 1) return matches[0]!.hostId;
  if (matches.length > 1) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `Client name "${selector}" matches ${
        matches.length
      } clients in this project. Use an ID instead: ${matches
        .map((row) => row.hostId)
        .join(", ")}`,
      { candidateIds: matches.map((row) => row.hostId) }
    );
  }
  throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Client not found");
}

/** `?includePrivateBacking=true` — administrative REST opt-in, never an agent's. */
function includePrivateBackingParam(c: Context): boolean {
  return c.req.query("includePrivateBacking") === "true";
}

// ── Schemas ─────────────────────────────────────────────────────────────────
const hostConfigSchema = z.record(z.string(), z.unknown());

/**
 * FORWARD-CLIENT INVARIANT: a client created through this route must pin a
 * model.
 *
 * An environment resolves its execution model from its own override, else from
 * the client it selects, else nowhere — and "nowhere" is a hard launch refusal
 * (`ENV_MODEL_REQUIRED`). A client minted with `modelId: ""` is therefore a
 * client that cannot back a headless environment, and the failure would surface
 * at launch rather than at creation.
 *
 * Deliberately a REFINEMENT over the passthrough record rather than a full
 * config schema: every other config field stays untyped here on purpose (the
 * authoritative validator is `ensureHostConfigV2` in the backend), and this
 * route should not acquire a second copy of it that can drift. Legacy rows with
 * an empty model are untouched — they still read, and unrelated edits still
 * apply; only NEW clients are held to the invariant.
 *
 * Applied in the outer `superRefine` rather than on the field, so the XOR
 * message still wins for a degenerate `config: {}` — that body's real problem
 * is that it picked neither branch, not that it forgot a model.
 */
function hostConfigPinsAModel(config: Record<string, unknown>): boolean {
  return typeof config.modelId === "string" && config.modelId.trim().length > 0;
}

/**
 * The keys a config READ adds that a config WRITE cannot accept.
 *
 * `GET /clients/:id` projects the stored row, which carries the config's own
 * row id and its schema version. Neither is in `hostConfigInputV2Validator`,
 * and that validator is a strict `v.object`, so handing a freshly-read config
 * straight back — the obvious `get`, edit one field, `update` loop, and what
 * every CLI/agent caller actually does — was rejected. Convex's
 * argument-validation error is deliberately not forwarded (it echoes the
 * arguments), so the caller got only "Client write rejected by the platform"
 * with no field named: a 500 for a body the API had just emitted.
 *
 * Stripped rather than named in a 400, because these are OUR derived fields,
 * not the caller's mistake. A genuinely unknown key still fails closed and
 * still logs, which is the behaviour the write translator documents.
 */
const READ_ONLY_CONFIG_KEYS = ["id", "schemaVersion"] as const;

/**
 * Return `config` ready for the Convex write: `modelId` TRIMMED, and the
 * read-only projection keys dropped so `get` output round-trips into `update`.
 *
 * The rest of the config is passed through opaquely, but the model cannot be:
 * it is stored verbatim and compared verbatim downstream, so a padded
 * `" anthropic/claude-sonnet-4-5 "` would be persisted as a distinct — and
 * unrecognized — model id. Trimming matches the environment contract's
 * `normalizeModelId`, which is the other write boundary this value reaches.
 * Only ever a trim; the id itself is never rewritten.
 */
function normalizeConfigForWrite(
  config: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...config };
  for (const key of READ_ONLY_CONFIG_KEYS) delete normalized[key];
  if (typeof normalized.modelId === "string") {
    normalized.modelId = normalized.modelId.trim();
  }
  return normalized;
}

const createClientSchema = z
  .strictObject({
    name: z.string().trim().min(1),
    template: z.string().trim().min(1).optional(),
    theme: z.enum(["light", "dark"]).optional(),
    config: hostConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // An empty `{}` is a truthy object but not a usable config; count config
    // only when it actually carries fields so `--json '{}'` can't satisfy the
    // XOR and mint a degenerate client.
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

const impactSchema = z.strictObject({
  liveEnvironmentCount: z.number().int().min(0),
  scenarioAttachmentCount: z.number().int().min(0),
  activeLegacyJourneyCount: z.number().int().min(0),
});

/**
 * The PARTIAL edit block. One named field per editable setting, mirroring the
 * backend's `hosts:updateHostFields` args exactly.
 *
 * `null` is accepted where the backend accepts it and means what the backend
 * makes it mean — reset for a required field, clear for an optional one — and
 * is refused on `modelId`, which is the one field a partial edit must not be
 * able to unpin.
 *
 * Object-valued fields (`connectionDefaults`, `mcpProfile`, …) are WHOLE-object
 * replacements, not merges. Deep knobs are edited by reading `get_client`,
 * overlaying the relevant sub-object, and sending it back whole. `hostStyle`,
 * `clientCapabilities`, `hostContext` and server membership are deliberately
 * absent — see the backend mutation's header.
 */
const clientSetSchema = z
  .strictObject({
    modelId: z.string().trim().min(1).optional(),
    systemPrompt: z.string().nullable().optional(),
    temperature: z.number().finite().nullable().optional(),
    requireToolApproval: z.boolean().nullable().optional(),
    connectionDefaults: z
      .strictObject({
        headers: z.record(z.string(), z.string()),
        requestTimeout: z.number().finite(),
      })
      .nullable()
      .optional(),
    respectToolVisibility: z.boolean().nullable().optional(),
    progressiveToolDiscovery: z.boolean().nullable().optional(),
    harness: z.enum(["claude-code", "codex"]).nullable().optional(),
    computer: z
      .strictObject({
        kind: z.literal("personal"),
        toolset: z.literal("bash").optional(),
        workdir: z.string().optional(),
      })
      .nullable()
      .optional(),
    builtInToolIds: z.array(z.string().trim().min(1)).nullable().optional(),
    skillSelection: z
      .union([
        z.strictObject({ mode: z.literal("all-visible") }),
        z.strictObject({
          mode: z.literal("explicit"),
          skillIds: z.array(z.string().trim().min(1)),
        }),
      ])
      .nullable()
      .optional(),
    modelVisibleMcpToolResults: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
    mcpToolResultImageRendering: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
    mcpProfile: z.record(z.string(), z.unknown()).nullable().optional(),
    hostCapabilitiesOverride: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
    chatUiOverride: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "`set` must name at least one field to change.",
  });

/**
 * The CANONICAL update body.
 *
 * `config` and `set` are exclusive: one replaces the whole config, the other
 * overlays named fields onto the config read inside the write transaction.
 * Accepting both would make "which wins" a question the contract has to answer
 * and nobody would remember the answer to.
 *
 * The tokens are REQUIRED here, and that is the point of the canonical surface.
 * A config write without `expectedConfigId` is a write that can silently revert
 * a concurrent edit; a rename without `expectedName` is a rename that can lose
 * one. `expectedImpact` stays optional because a direct REST caller usually has
 * no approval copy to keep honest — the agent surface always sends it.
 */
const updateClientSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    expectedName: z.string().min(1).optional(),
    expectedConfigId: z.string().trim().min(1).optional(),
    expectedImpact: impactSchema.optional(),
    config: hostConfigSchema.optional(),
    set: clientSetSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasConfig = value.config !== undefined;
    const hasSet = value.set !== undefined;
    if (hasConfig && hasSet) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide either `config` (whole-config replacement) or `set` (named fields), not both.",
      });
      return;
    }
    if (!hasConfig && !hasSet && value.name === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one of `name`, `config`, or `set` to edit.",
      });
      return;
    }
    if ((hasConfig || hasSet) && value.expectedConfigId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedConfigId"],
        message:
          "`expectedConfigId` is required for a config edit: send the `configId` you last read for this client so a concurrent edit is rejected rather than overwritten.",
      });
    }
    if (value.name !== undefined && value.expectedName === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedName"],
        message:
          "`expectedName` is required for a rename: send the `name` you last read for this client. A rename does not change the config, so `expectedConfigId` cannot detect a concurrent one.",
      });
    }
  });

/** The DEPRECATED `/hosts` update body — unchanged, tokenless, lenient. */
const updateHostSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    config: hostConfigSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: "Provide at least one of `name` or `config` to update.",
  });

const setClientServersSchema = z.strictObject({
  serverIds: z.array(z.string().trim().min(1)),
  optionalServerIds: z.array(z.string().trim().min(1)).optional(),
  // The message rides on BOTH the string schema and the length check: an
  // omitted property fails `z.string()` with `invalid_type` and would otherwise
  // report a generic "expected string, received undefined", while a blank one
  // fails `.min(1)`. Forgetting the token and sending an empty one are the same
  // mistake and deserve the same sentence.
  expectedConfigId: z
    .string({
      error:
        "`expectedConfigId` is required: replacing a client's servers rewrites its config, and without the token a concurrent server change is silently lost.",
    })
    .trim()
    .min(1, {
      message:
        "`expectedConfigId` is required: replacing a client's servers rewrites its config, and without the token a concurrent server change is silently lost.",
    }),
  expectedImpact: impactSchema.optional(),
});

/** The DEPRECATED `/hosts/:hostId/servers` body — unchanged, tokenless. */
const updateHostServersSchema = z.strictObject({
  serverIds: z.array(z.string().trim().min(1)),
  optionalServerIds: z.array(z.string().trim().min(1)).optional(),
});

const duplicateClientSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
});

// ── Handlers ────────────────────────────────────────────────────────────────
//
// One implementation per operation, parameterized by `legacy`. Registration
// below mounts each at both path shapes.

type Surface = { legacy: boolean };

async function listHandler(c: Context, { legacy }: Surface) {
  const projectId = pathParam(c, "projectId");
  const rows = await listHostRows(
    await getConvexBearerForRequest(c),
    projectId
  );
  if (legacy) {
    markDeprecated(c);
    return v1PageJson(c, rows.map(toLegacyHostDto));
  }
  // UI parity: the Clients list hides private User Testing backing rows, and a
  // canonical API that showed them would disagree with the product's own
  // definition of what a client is. Opt-in for administrative callers.
  const visible = includePrivateBackingParam(c)
    ? rows
    : rows.filter((row) => !isPrivateBacking(row));
  return v1PageJson(c, visible.map(toClientDto));
}

/**
 * Resolve the path's client segment, honoring the surface's rules.
 *
 * The legacy `/hosts` paths are ID-ONLY — they always were, and teaching a
 * deprecated surface to resolve names would give it a capability the canonical
 * one is meant to be the reason to move to.
 */
async function resolveSelector(
  c: Context,
  token: string,
  { legacy }: Surface
): Promise<string> {
  const projectId = pathParam(c, "projectId");
  if (legacy) return pathParam(c, "hostId");
  return resolveClientId(
    token,
    projectId,
    pathParam(c, "client"),
    includePrivateBackingParam(c)
  );
}

function detailResponse(c: Context, detail: HostDetailRow, legacy: boolean) {
  if (legacy) {
    markDeprecated(c);
    return v1Resource(c, toLegacyHostDetailDto(detail));
  }
  return v1Resource(c, toClientDetailDto(detail));
}

async function getHandler(c: Context, surface: Surface) {
  const projectId = pathParam(c, "projectId");
  const token = await getConvexBearerForRequest(c);
  const clientId = await resolveSelector(c, token, surface);
  const detail = await readHostDetail(token, projectId, clientId);
  // A hidden backing row reached by ID on the canonical surface is a 404, not
  // a read: the default-exclusion rule is about what a client IS, so it cannot
  // hold for names and lapse for ids.
  if (
    !surface.legacy &&
    !includePrivateBackingParam(c) &&
    isPrivateBacking(detail)
  ) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Client not found");
  }
  return detailResponse(c, detail, surface.legacy);
}

async function createHandler(c: Context, surface: Surface) {
  const projectId = pathParam(c, "projectId");
  const body = parseWithSchema(createClientSchema, await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);
  const convexClient = createConvexClient(token);

  // Trim on BOTH branches: the normalization belongs to the write boundary, not
  // to one of the two ways of reaching it. A template is authored data too, and
  // one carrying a padded `modelId` would otherwise persist an id that no
  // downstream verbatim comparison recognizes.
  const input = normalizeConfigForWrite(
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
  const detail = await readHostDetail(token, projectId, created.hostId);
  if (surface.legacy) {
    markDeprecated(c);
    return v1Resource(c, toLegacyHostDetailDto(detail), 201);
  }
  return v1Resource(c, toClientDetailDto(detail), 201);
}

/**
 * Refuse an edit that would strip the model off a client that pins one.
 *
 * Only reachable on the whole-config branch: a partial `set` has no way to
 * express an empty model (the backend rejects blank and has no null), so the
 * check belongs to the replacement path alone. Convex enforces the same rule
 * inside the mutation — this preflight exists to give the caller the specific
 * 400 rather than a generic write refusal, not to be the enforcement.
 */
function assertConfigKeepsPinnedModel(
  current: HostDetailRow,
  nextConfig: Record<string, unknown>
): void {
  if (
    hostConfigPinsAModel(current.config) &&
    !hostConfigPinsAModel(nextConfig)
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "`config.modelId` is required and must be a non-empty model id: this client pins a model, and clearing it would leave it unable to back a headless environment.",
      { modelId: current.config.modelId }
    );
  }
}

async function updateClientHandler(c: Context) {
  const projectId = pathParam(c, "projectId");
  const body = parseWithSchema(updateClientSchema, await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);
  const clientId = await resolveClientId(
    token,
    projectId,
    pathParam(c, "client"),
    includePrivateBackingParam(c)
  );
  const convexClient = createConvexClient(token);

  const tokens = {
    ...(body.expectedConfigId === undefined
      ? {}
      : { expectedHostConfigId: body.expectedConfigId }),
    ...(body.expectedName === undefined
      ? {}
      : { expectedName: body.expectedName }),
    ...(body.expectedImpact === undefined
      ? {}
      : { expectedImpact: body.expectedImpact }),
  };

  try {
    if (body.config !== undefined) {
      // The whole-config branch keeps `updateHost`'s replacement semantics; the
      // preflight read is only for the specific model-clearing 400.
      assertConfigKeepsPinnedModel(
        await readHostDetail(token, projectId, clientId),
        body.config
      );
      await convexClient.mutation(
        "hosts:updateHost" as any,
        {
          hostId: clientId,
          projectId,
          ...(body.name === undefined ? {} : { name: body.name }),
          input: normalizeConfigForWrite(body.config),
          ...tokens,
        } as any
      );
    } else {
      // Rename-only and partial edits both go through the partial mutation: it
      // owns the "no effective change writes nothing" rule, which a rename
      // through `updateHost` would violate by bumping `updatedAt`.
      await convexClient.mutation(
        "hosts:updateHostFields" as any,
        {
          hostId: clientId,
          projectId,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.set === undefined ? {} : { set: body.set }),
          ...tokens,
        } as any
      );
    }
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(
    c,
    toClientDetailDto(await readHostDetail(token, projectId, clientId))
  );
}

/** The DEPRECATED `/hosts/:hostId` PATCH — replacement-only, no tokens. */
async function updateHostAliasHandler(c: Context) {
  const projectId = pathParam(c, "projectId");
  const hostId = pathParam(c, "hostId");
  const body = parseWithSchema(updateHostSchema, await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);

  const updateArgs: Record<string, unknown> = { hostId, projectId };
  if (body.name !== undefined) updateArgs.name = body.name;
  if (body.config !== undefined) {
    assertConfigKeepsPinnedModel(
      await readHostDetail(token, projectId, hostId),
      body.config
    );
    updateArgs.input = normalizeConfigForWrite(body.config);
  }
  const convexClient = createConvexClient(token);
  try {
    await convexClient.mutation("hosts:updateHost" as any, updateArgs);
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  markDeprecated(c);
  return v1Resource(
    c,
    toLegacyHostDetailDto(await readHostDetail(token, projectId, hostId))
  );
}

async function setServersHandler(c: Context, surface: Surface) {
  const projectId = pathParam(c, "projectId");
  const token = await getConvexBearerForRequest(c);
  const clientId = await resolveSelector(c, token, surface);
  const body = surface.legacy
    ? parseWithSchema(updateHostServersSchema, await readJsonObjectBody(c))
    : parseWithSchema(setClientServersSchema, await readJsonObjectBody(c));
  const convexClient = createConvexClient(token);
  try {
    await convexClient.mutation("hosts:updateHostServers" as any, {
      projectId,
      hostId: clientId,
      serverIds: body.serverIds,
      optionalServerIds: body.optionalServerIds,
      ...("expectedConfigId" in body
        ? { expectedHostConfigId: body.expectedConfigId }
        : {}),
      ...("expectedImpact" in body && body.expectedImpact !== undefined
        ? { expectedImpact: body.expectedImpact }
        : {}),
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return detailResponse(
    c,
    await readHostDetail(token, projectId, clientId),
    surface.legacy
  );
}

async function duplicateHandler(c: Context, surface: Surface) {
  const projectId = pathParam(c, "projectId");
  const token = await getConvexBearerForRequest(c);
  const clientId = await resolveSelector(c, token, surface);
  const body = parseWithSchema(
    duplicateClientSchema,
    await readJsonObjectBody(c)
  );
  const convexClient = createConvexClient(token);

  // Duplication MINTS a client, so it is held to the same forward-client
  // invariant as `create`. Copying a legacy modelless row is the one way this
  // route could keep producing the state `create` now refuses — and unlike an
  // edit to a legacy row, nothing is stranded by refusing: the source still
  // exists, and pinning its model makes the copy legal.
  const source = await readHostDetail(token, projectId, clientId);
  if (!hostConfigPinsAModel(source.config)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Client "${source.name}" does not pin a model, so duplicating it would create another client that cannot back a headless environment. Pin a model on it first.`
    );
  }

  let created: { hostId: string };
  try {
    created = (await convexClient.mutation("hosts:duplicateHost" as any, {
      projectId,
      hostId: clientId,
      ...(body.name === undefined ? {} : { name: body.name }),
    })) as { hostId: string };
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  const detail = await readHostDetail(token, projectId, created.hostId);
  if (surface.legacy) {
    markDeprecated(c);
    return v1Resource(c, toLegacyHostDetailDto(detail), 201);
  }
  return v1Resource(c, toClientDetailDto(detail), 201);
}

async function deleteHandler(c: Context, surface: Surface) {
  const projectId = pathParam(c, "projectId");
  const token = await getConvexBearerForRequest(c);
  const clientId = await resolveSelector(c, token, surface);
  // Delete takes no body. Parse the caller's JSON (no synthesized path
  // params) against a strict empty object so a leftover `force` — or a
  // stray `projectId` — is a VALIDATION_ERROR that names the key.
  parseWithSchema(z.strictObject({}), await readJsonObjectBody(c));
  // `hosts:deleteHost` enforces project scope from `projectId`.
  const convexClient = createConvexClient(token);
  try {
    await convexClient.mutation("hosts:deleteHost" as any, {
      hostId: clientId,
      projectId,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  if (surface.legacy) markDeprecated(c);
  return v1Resource(c, { id: clientId, deleted: true });
}

// ── Routes ───────────────────────────────────────────────────────────────────

const CANONICAL: Surface = { legacy: false };
const LEGACY: Surface = { legacy: true };

// Canonical: GET /v1/projects/:projectId/clients
clients.get("/projects/:projectId/clients", (c) => listHandler(c, CANONICAL));
// Canonical detail routes take a client NAME or ID.
clients.get("/projects/:projectId/clients/:client", (c) =>
  getHandler(c, CANONICAL)
);
clients.post("/projects/:projectId/clients", (c) =>
  createHandler(c, CANONICAL)
);
clients.patch("/projects/:projectId/clients/:client", updateClientHandler);
clients.post("/projects/:projectId/clients/:client/servers", (c) =>
  setServersHandler(c, CANONICAL)
);
clients.post("/projects/:projectId/clients/:client/duplicate", (c) =>
  duplicateHandler(c, CANONICAL)
);
clients.delete("/projects/:projectId/clients/:client", (c) =>
  deleteHandler(c, CANONICAL)
);

// Deprecated aliases: the original `/hosts` paths, ID-only, old DTOs, old
// (tokenless) write contracts. Kept working indefinitely; every response
// carries `Deprecation: true`.
clients.get("/projects/:projectId/hosts", (c) => listHandler(c, LEGACY));
clients.get("/projects/:projectId/hosts/:hostId", (c) => getHandler(c, LEGACY));
clients.post("/projects/:projectId/hosts", (c) => createHandler(c, LEGACY));
clients.patch("/projects/:projectId/hosts/:hostId", updateHostAliasHandler);
clients.post("/projects/:projectId/hosts/:hostId/servers", (c) =>
  setServersHandler(c, LEGACY)
);
clients.post("/projects/:projectId/hosts/:hostId/duplicate", (c) =>
  duplicateHandler(c, LEGACY)
);
clients.delete("/projects/:projectId/hosts/:hostId", (c) =>
  deleteHandler(c, LEGACY)
);

export default clients;
