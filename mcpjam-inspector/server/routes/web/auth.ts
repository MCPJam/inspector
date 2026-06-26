import { z } from "zod";
import type { Context } from "hono";
import {
  MCPClientManager,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  type McpProtocolVersion,
} from "@mcpjam/sdk";
import type {
  HttpServerConfig,
  RpcLogger,
  UnauthorizedRefreshHandler,
} from "@mcpjam/sdk";
import { HOSTED_MODE, WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  attachHostedRpcLogs,
  createHostedRpcLogCollector,
} from "./hosted-rpc-logs.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { setRequestLogContext } from "../../utils/request-logger.js";
import { logger } from "../../utils/logger.js";
import type { RequestLogContext } from "../../utils/log-events.js";
import {
  type InternalLogContext,
  mapInternalToRequestContext,
} from "../../utils/internal-log-context.js";
import {
  ErrorCode,
  WebRouteError,
  webError,
  parseErrorMessage,
  mapRuntimeError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./errors.js";
import { buildHostedOAuthUnauthorizedHandler } from "../../utils/hosted-oauth-refresh.js";
import {
  fetchRuntimeServerSecrets,
  fetchServerClientSecret,
} from "../../utils/server-secrets.js";
import {
  buildXaaMintArgs,
  mintXaaAccessToken,
  resolveXaaIssuer,
} from "../../services/xaa-mint.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

const clientCapabilitiesSchema = z.record(z.string(), z.unknown());
const clientInfoBatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  })
  .passthrough()
  .optional();
const supportedProtocolVersionsBatchSchema = z
  .array(z.string().min(1))
  .optional();
const mcpProtocolVersionEnum = z.enum([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

function hasNonEmptyStringRecord(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).some(
      ([, recordValue]) => typeof recordValue === "string"
    )
  );
}

// Per-server `mcpProtocolVersion` map. Map entries are validated against
// the wire-mode enum so a typo in one server's pin doesn't tank the whole
// batch — Zod returns the typed enum union, and the route handler can
// still defensively re-check via `isKnownProtocolVersion` before passing
// to the SDK factory.
export const mcpProtocolVersionsByServerIdSchema = z
  .record(z.string().min(1), mcpProtocolVersionEnum)
  .optional();

export const projectServerSchema = z.object({
  projectId: z.string().min(1),
  serverId: z.string().min(1),
  serverName: z.string().min(1).optional(),
  clientCapabilities: clientCapabilitiesSchema.optional(),
  oauthAccessToken: z.string().optional(),
  accessScope: z.enum(["project_member", "chat_v2"]).optional(),
  // Callers identify chatboxes by `chatboxId` (resolved via
  // /web/chatbox/redeem) plus the backend-owned `accessVersion`. The
  // link token is consumed only at redemption; no read-path callsite
  // accepts it.
  chatboxId: z.string().min(1).optional(),
  accessVersion: z.number().int().nonnegative().optional(),
  // mcpProfile.initialize pins, resolved client-side from
  // `hostConfig.mcpProfile.initialize.*` and forwarded on every hosted
  // route call. Declared here (rather than per-route) so Zod doesn't
  // strip them — the inspector client now ALWAYS includes them on
  // /validate, /check-oauth, /doctor, /tools/*, /resources/*, /prompts/*
  // when the active hostConfig has a profile pinned. `passthrough()` on
  // clientInfo so forward-compat MCP spec additions (e.g. `title`,
  // future fields) survive to `toHttpConfig` without a schema bump.
  clientInfo: z
    .object({
      name: z.string().min(1).optional(),
      version: z.string().min(1).optional(),
    })
    .passthrough()
    .optional(),
  supportedProtocolVersions: z.array(z.string().min(1)).optional(),
  // Per-server pinned MCP protocol version. Resolved client-side from
  // `hostConfig.mcpProfile.mcpProtocolVersion` + per-server override.
  // Membership-gated via `MCP_PROTOCOL_VERSIONS` (mirror of the SDK +
  // backend constant); typo values are rejected at this trust boundary
  // and never reach the SDK's open-routing predicate. Absent means
  // "use SDK default (negotiates at request time)".
  mcpProtocolVersion: mcpProtocolVersionEnum.optional(),
});

export const toolsListSchema = projectServerSchema.extend({
  modelId: z.string().optional(),
  cursor: z.string().optional(),
});

export const toolsExecuteSchema = projectServerSchema.extend({
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
  taskOptions: z.record(z.string(), z.unknown()).optional(),
});

export const resourcesListSchema = projectServerSchema.extend({
  cursor: z.string().optional(),
});

export const resourcesReadSchema = projectServerSchema.extend({
  uri: z.string().min(1),
});

export const promptsListSchema = projectServerSchema.extend({
  cursor: z.string().optional(),
});

export const promptsListMultiSchema = z.object({
  projectId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  serverNames: z.array(z.string().min(1)).optional(),
  clientCapabilities: clientCapabilitiesSchema.optional(),
  // mcpProfile.initialize pins, threaded from the active host profile so
  // multi-server prompts list connects honor the same protocol pins as
  // single-server calls. `clientInfo` and `supportedProtocolVersions` are
  // host-level (uniform per batch). `mcpProtocolVersionsByServerId` is
  // per-server so different servers in the batch can be on different
  // wire modes (e.g. one pinned to 2026-07-28 stateless, others on
  // legacy 2025-11-25 negotiation).
  clientInfo: clientInfoBatchSchema,
  supportedProtocolVersions: supportedProtocolVersionsBatchSchema,
  mcpProtocolVersionsByServerId: mcpProtocolVersionsByServerIdSchema,
  oauthTokens: z.record(z.string(), z.string()).optional(),
  accessScope: z.enum(["project_member", "chat_v2"]).optional(),
  // See projectServerSchema — chatbox identity is `chatboxId` + `accessVersion`.
  chatboxId: z.string().min(1).optional(),
  accessVersion: z.number().int().nonnegative().optional(),
});

export const promptsGetSchema = projectServerSchema.extend({
  promptName: z.string().min(1),
  arguments: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

export const hostedChatSchema = z
  .object({
    projectId: z.string().min(1),
    selectedServerIds: z.array(z.string().min(1)),
    selectedServerNames: z.array(z.string().min(1)).optional(),
    clientCapabilities: clientCapabilitiesSchema.optional(),
    chatSessionId: z.string().min(1).optional(),
    surface: z.enum(["preview", "share_link"]).optional(),
    oauthTokens: z.record(z.string(), z.string()).optional(),
    accessScope: z.enum(["project_member", "chat_v2"]).optional(),
    // See projectServerSchema — chatbox identity is `chatboxId` + `accessVersion`.
    chatboxId: z.string().min(1).optional(),
    accessVersion: z.number().int().nonnegative().optional(),
  })
  .passthrough();

// ── Helpers ──────────────────────────────────────────────────────────

export function buildSingleServerOAuthTokens(serverId: string, token?: string) {
  return token ? { [serverId]: token } : undefined;
}

function buildServerNamesById(
  serverIds: string[],
  serverNames?: readonly string[]
): Record<string, string> | undefined {
  if (!Array.isArray(serverNames) || serverNames.length === 0) {
    return undefined;
  }

  const entries = serverIds.flatMap((serverId, index) => {
    const serverName = serverNames[index];
    if (typeof serverName !== "string") {
      return [];
    }

    const trimmedServerName = serverName.trim();
    if (!trimmedServerName) {
      return [];
    }

    return [[serverId, trimmedServerName] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ── Authorization ────────────────────────────────────────────────────

export type ConvexAuthorizeResponse = {
  authorized: boolean;
  role: "owner" | "admin" | "member";
  accessLevel: "project_member" | "shared_chat";
  oauthAccessToken?: string | null;
  permissions: {
    chatOnly: boolean;
  };
  serverConfig: {
    transportType: "stdio" | "http";
    url?: string;
    headers?: Record<string, string>;
    hasHeaders?: boolean;
    useOAuth?: boolean;
    // Cross-App Access (XAA) discriminator + non-secret config, surfaced by the
    // hosted authorize endpoint. The confidential client secret + token endpoint
    // are resolved separately at mint time via the hardened reveal-secret path.
    useXaa?: boolean;
    oauthScopes?: string[];
    xaaSubject?: string;
    xaaEmail?: string;
  };
  internalLogContext?: InternalLogContext;
};

export type ClientSafeAuthorizeResponse = Omit<
  ConvexAuthorizeResponse,
  "internalLogContext"
>;

type AuthorizedServerConfigHolder = {
  serverConfig: ConvexAuthorizeResponse["serverConfig"];
};

export type ConvexBatchAuthorizeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type ConvexBatchAuthorizeSuccess = {
  ok: true;
  role: "owner" | "admin" | "member";
  accessLevel: "project_member" | "shared_chat";
  oauthAccessToken?: string | null;
  permissions: {
    chatOnly: boolean;
  };
  serverConfig: Omit<
    ConvexAuthorizeResponse,
    "internalLogContext"
  >["serverConfig"];
  internalLogContext?: InternalLogContext;
};

export type ConvexBatchAuthorizeResult =
  | ConvexBatchAuthorizeFailure
  | ConvexBatchAuthorizeSuccess;

export type ConvexBatchAuthorizeResponse = {
  results: Record<string, ConvexBatchAuthorizeResult>;
};

// Defense-in-depth: hosted /web/authorize-batch is contractually meant to
// return an HTTP-only `serverConfig` — Convex strips command/args/env via
// `normalizeAuthorizeResult`. If a backend regression ever lets those fields
// through, we drop them here so they can never reach the hosted client or be
// fed into a transport. Local mode uses /web/authorize-batch-local instead,
// which is allowed to carry STDIO fields and goes through a different code
// path (`local-server-resolver.ts`).
const STDIO_ONLY_FIELDS = ["command", "args", "env"] as const;
function stripStdioFieldsFromHostedConfig<
  T extends { serverConfig?: Record<string, unknown> }
>(holder: T): T {
  const cfg = holder.serverConfig;
  if (!cfg || typeof cfg !== "object") return holder;
  let cleaned: Record<string, unknown> | undefined;
  for (const field of STDIO_ONLY_FIELDS) {
    if (field in cfg) {
      if (!cleaned) cleaned = { ...cfg };
      delete cleaned[field];
    }
  }
  if (!cleaned) return holder;
  return { ...holder, serverConfig: cleaned };
}

/**
 * Build the auth headers used by Inspector → Convex `/web/*` calls.
 *
 * - For session/guest JWTs (the default): forward the caller's bearer
 *   verbatim. Convex sees the same identity it always has.
 * - For WorkOS API keys (`authMethod === "workos_api_key"`): exchange
 *   the bearer for `INSPECTOR_SERVICE_TOKEN` and add
 *   `x-mcpjam-acting-as: <workosUserId>` (the user's Convex `externalId`)
 *   plus `x-mcpjam-acting-in-org: <mcpjamOrganizationId>` (the org the key
 *   is bound to). Convex never sees the `sk_` value — Inspector is the
 *   trust boundary that validated it once via WorkOS and now vouches for
 *   the resolved user, scoped to the key's organization. The backend
 *   `requestIdentity` resolver requires BOTH headers and re-checks that the
 *   user is a member of that org.
 *
 * Keeping this in one helper so every `/web/*` callsite picks up the
 * same exchange (currently `authorizeServer` and `authorizeBatch` in
 * this file). Other Convex-forwarding helpers under `server/utils/*`
 * (e.g. `chat-history.ts`, `hosted-oauth-refresh.ts`,
 * `local-server-resolver.ts`) are NOT on the `/api/v1/*` path today
 * and stay on the original-bearer path until they're either reached
 * by an API key request or refactored to receive Context.
 */
/**
 * The caller-identity inputs the authorize/manager helpers actually consume,
 * decoupled from Hono so background workers (scheduled evals) can call them
 * without faking a route context. Routes build one via
 * {@link callerContextFromHono}; workers pass explicit values (or the empty
 * object, which behaves exactly like a plain-JWT caller — locked by
 * `caller-context.test.ts`).
 */
export interface ManagerCallerContext {
  /** "workos_api_key" switches to the service-token + acting-as exchange. */
  authMethod?: string;
  /** WorkOS user id (Convex `externalId`) for the delegated exchange. */
  workosUserId?: string;
  /** Convex organization id scope for the delegated exchange. */
  mcpjamOrganizationId?: string;
  /** Sink for backend-attributed request log context; absent ⇒ no-op. */
  setLogContext?: (partial: Partial<RequestLogContext>) => void;
  /** Read-back of the same log context (authenticatedUserId); absent ⇒ null. */
  getLogContext?: () => RequestLogContext | undefined;
}

/** Adapt a live Hono request context to {@link ManagerCallerContext}. */
export function callerContextFromHono(c: Context): ManagerCallerContext {
  return {
    authMethod: c.get("authMethod") as string | undefined,
    workosUserId: c.get("workosUserId") as string | undefined,
    mcpjamOrganizationId: c.get("mcpjamOrganizationId") as string | undefined,
    setLogContext: (partial) => setRequestLogContext(c, partial),
    getLogContext: () => c.var.requestLogContext,
  };
}

export function buildConvexAuthHeaders(
  caller: ManagerCallerContext,
  originalBearer: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (caller.authMethod === "workos_api_key") {
    const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
    if (!serviceToken) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing INSPECTOR_SERVICE_TOKEN for WorkOS API key auth"
      );
    }
    // `acting-as` is the WorkOS user id (the user's Convex `externalId`),
    // NOT the Convex user `_id`: the backend resolves the delegated user by
    // externalId. Sending the Convex id here would 404 as UNKNOWN_DELEGATED_USER.
    const actingAs = caller.workosUserId;
    if (!actingAs) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Missing workosUserId for WorkOS API key auth exchange"
      );
    }
    const actingInOrg = caller.mcpjamOrganizationId;
    if (!actingInOrg) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Missing mcpjamOrganizationId for WorkOS API key auth exchange"
      );
    }
    headers["Authorization"] = `Bearer ${serviceToken}`;
    headers["x-mcpjam-acting-as"] = actingAs;
    headers["x-mcpjam-acting-in-org"] = actingInOrg;
    return headers;
  }
  headers["Authorization"] = `Bearer ${originalBearer}`;
  return headers;
}

export async function authorizeServer(
  c: Context,
  bearerToken: string,
  projectId: string,
  serverId: string,
  options?: {
    accessScope?: "project_member" | "chat_v2";
    chatboxId?: string;
    accessVersion?: number;
  }
): Promise<ClientSafeAuthorizeResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize`, {
      method: "POST",
      headers: buildConvexAuthHeaders(callerContextFromHono(c), bearerToken),
      body: JSON.stringify({
        projectId,
        serverId,
        ...(options?.accessScope ? { accessScope: options.accessScope } : {}),
        ...(options?.chatboxId ? { chatboxId: options.chatboxId } : {}),
        ...(typeof options?.accessVersion === "number"
          ? { accessVersion: options.accessVersion }
          : {}),
      }),
    });
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Failed to reach authorization service: ${parseErrorMessage(error)}`
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code =
      typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Authorization failed (${response.status})`;
    throw new WebRouteError(response.status, code as ErrorCode, message);
  }

  if (!body?.authorized || !body?.serverConfig) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Authorization denied for server"
    );
  }

  const { internalLogContext, ...clientSafe } = body as ConvexAuthorizeResponse;
  if (internalLogContext) {
    setRequestLogContext(c, mapInternalToRequestContext(internalLogContext));
  }
  return stripStdioFieldsFromHostedConfig(
    clientSafe
  ) as ClientSafeAuthorizeResponse;
}

export async function authorizeBatch(
  caller: ManagerCallerContext,
  bearerToken: string,
  projectId: string,
  serverIds: string[],
  options?: {
    accessScope?: "project_member" | "chat_v2";
    chatboxId?: string;
    accessVersion?: number;
  }
): Promise<ConvexBatchAuthorizeResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize-batch`, {
      method: "POST",
      headers: buildConvexAuthHeaders(caller, bearerToken),
      body: JSON.stringify({
        projectId,
        serverIds,
        ...(options?.accessScope ? { accessScope: options.accessScope } : {}),
        ...(options?.chatboxId ? { chatboxId: options.chatboxId } : {}),
        ...(typeof options?.accessVersion === "number"
          ? { accessVersion: options.accessVersion }
          : {}),
        // Skip Convex's hosted-mode HTTPS-only check on MCP server URLs
        // when this Inspector instance is running locally. Convex doesn't
        // open MCP server URLs itself (we do, from this Hono backend), so
        // an `http://localhost` URL is harmless metadata in that case.
        //
        // Convex only honors `localRuntime` when the request has no
        // browser Origin, so a hosted browser at app.mcpjam.com can't
        // smuggle it in to bypass the policy. The flag itself isn't
        // Inspector-specific — any non-browser caller can set it — see
        // the docstring on `normalizeAuthorizeResult` in
        // mcpjam-backend/convex/http.ts for the full rationale.
        ...(!HOSTED_MODE ? { localRuntime: true } : {}),
      }),
    });
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Failed to reach authorization service: ${parseErrorMessage(error)}`
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code =
      typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Authorization failed (${response.status})`;
    throw new WebRouteError(response.status, code as ErrorCode, message);
  }

  if (!body?.results || typeof body.results !== "object") {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorization response is missing batch results"
    );
  }

  const raw = body as ConvexBatchAuthorizeResponse;

  // Project-level fields (auth/user/org/project/accessLevel/surface) are
  // identical across batch results by construction — same Convex auth call,
  // same project. Take them from the first successful result.
  //
  // Per-server fields (serverId, serverTransport, chatboxId) are only well-
  // defined when the batch authorizes a single server. For multi-server
  // batches they would non-deterministically attribute to whichever server
  // iterated last, so we null them out at the request envelope; per-server
  // attribution belongs on per-server child events.
  const successful = Object.entries(raw.results).filter(
    (entry): entry is [string, ConvexBatchAuthorizeSuccess] => entry[1].ok
  );
  // Use the first result that actually carries internalLogContext rather than
  // strictly successful[0]; during a backend rollout the field may be present
  // on some results and absent on others, and we'd rather log project
  // attribution than nothing.
  const sourceCtx = successful.find(([, r]) => r.internalLogContext)?.[1]
    .internalLogContext;
  if (sourceCtx) {
    const partial = mapInternalToRequestContext(sourceCtx);
    if (successful.length > 1) {
      partial.serverId = null;
      partial.serverTransport = null;
      partial.chatboxId = null;
    }
    caller.setLogContext?.(partial);
  }

  const strippedResults: Record<string, ConvexBatchAuthorizeResult> = {};
  for (const [serverId, result] of Object.entries(raw.results)) {
    if (result.ok) {
      const { internalLogContext: _omit, ...clientSafeResult } = result;
      strippedResults[serverId] = stripStdioFieldsFromHostedConfig(
        clientSafeResult
      ) as ConvexBatchAuthorizeSuccess;
    } else {
      strippedResults[serverId] = result;
    }
  }
  return { results: strippedResults };
}

export function toHttpConfig(
  authResponse: AuthorizedServerConfigHolder,
  timeoutMs: number,
  oauthAccessToken?: string,
  clientCapabilities?: Record<string, unknown>,
  onUnauthorized?: UnauthorizedRefreshHandler,
  /**
   * Per-connection MCP `initialize.params.clientInfo` and
   * `supportedProtocolVersions` pins resolved from
   * `hostConfig.mcpProfile.initialize.*`. Forwarded verbatim to the SDK
   * Client config so hosted connects honor the same pin as the
   * local-resolver path.
   *
   * Without this, the client was sending the pins on the wire but the
   * hosted handler dropped them at the route boundary (codex P2): Zod
   * stripped fields not declared on the schema, and `toHttpConfig`
   * had no parameters that could place them on the SDK config.
   */
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    /**
     * Outbound wire mode (2026-07-28 stateless preview). Forwarded
     * onto `HttpServerConfig.mcpProtocolVersion` so the SDK factory branches
     * to `StatelessMcpHttpPreviewClient` when set. Without this,
     * the hosted handler dropped the pin at the route boundary and
     * hosted connects always ran the legacy `initialize` handshake
     * regardless of the client-level toggle.
     */
    mcpProtocolVersion?: McpProtocolVersion;
  }
): HttpServerConfig {
  if (authResponse.serverConfig.transportType !== "http") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Only HTTP transport is supported in hosted mode"
    );
  }

  if (!authResponse.serverConfig.url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorized server is missing URL"
    );
  }

  const headers: Record<string, string> = {
    ...(authResponse.serverConfig.headers ?? {}),
  };

  if (oauthAccessToken) {
    headers["Authorization"] = `Bearer ${oauthAccessToken}`;
  }

  return {
    url: authResponse.serverConfig.url,
    capabilities: clientCapabilities,
    clientCapabilities: clientCapabilities,
    requestInit: {
      headers,
    },
    timeout: timeoutMs,
    ...(onUnauthorized ? { onUnauthorized } : {}),
    // mcpProfile.initialize.* pins, forwarded to the SDK's
    // `BaseServerConfig.clientInfo` / `.supportedProtocolVersions` per
    // `sdk/src/mcp-client-manager/types.ts`. Undefined → SDK defaults.
    ...(initializePins?.clientInfo
      ? { clientInfo: initializePins.clientInfo }
      : {}),
    ...(initializePins?.supportedProtocolVersions &&
    initializePins.supportedProtocolVersions.length > 0
      ? {
          supportedProtocolVersions: initializePins.supportedProtocolVersions,
        }
      : {}),
    ...(initializePins?.mcpProtocolVersion
      ? { mcpProtocolVersion: initializePins.mcpProtocolVersion }
      : {}),
  };
}

export interface AuthorizedManagerResult {
  manager: MCPClientManager;
  /** Maps serverId → serverUrl for servers that have useOAuth enabled */
  oauthServerUrls: Record<string, string>;
  /** Server-authenticated Convex user/guest id for this request, when known. */
  authenticatedUserId?: string | null;
}

function resolveEffectiveInitializePinsForServer(
  serverId: string,
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: McpProtocolVersion;
  },
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>
):
  | {
      clientInfo?: { name?: string; version?: string } & Record<
        string,
        unknown
      >;
      supportedProtocolVersions?: string[];
      mcpProtocolVersion?: McpProtocolVersion;
    }
  | undefined {
  const perServerPin = mcpProtocolVersionsByServerId?.[serverId];
  const mcpProtocolVersion =
    typeof perServerPin === "string" && isKnownProtocolVersion(perServerPin)
      ? perServerPin
      : initializePins?.mcpProtocolVersion;
  const supportedProtocolVersions =
    mcpProtocolVersion &&
    !isStatelessProtocolVersion(mcpProtocolVersion) &&
    initializePins?.supportedProtocolVersions?.includes(mcpProtocolVersion)
      ? [mcpProtocolVersion]
      : initializePins?.supportedProtocolVersions;

  const resolved = {
    ...(initializePins?.clientInfo
      ? { clientInfo: initializePins.clientInfo }
      : {}),
    ...(supportedProtocolVersions && supportedProtocolVersions.length > 0
      ? { supportedProtocolVersions }
      : {}),
    ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
  };

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export async function createAuthorizedManager(
  caller: ManagerCallerContext,
  bearerToken: string,
  projectId: string,
  serverIds: string[],
  timeoutMs: number,
  oauthTokens?: Record<string, string>,
  clientCapabilities?: Record<string, unknown>,
  options?: {
    accessScope?: "project_member" | "chat_v2";
    chatboxId?: string;
    accessVersion?: number;
    rpcLogger?: RpcLogger;
    serverNames?: string[];
    /**
     * mcpProfile.initialize.* pins. `clientInfo` and
     * `supportedProtocolVersions` are host-profile-level — they apply
     * uniformly to every authorized server in the batch.
     * `mcpProtocolVersion` is the batch-uniform fallback wire mode;
     * `mcpProtocolVersionsByServerId` (sibling option below) overrides
     * it per server. This lets a batch contain one server pinned to
     * 2026-07-28 stateless alongside another on legacy
     * 2025-11-25 negotiation.
     */
    initializePins?: {
      clientInfo?: { name?: string; version?: string } & Record<
        string,
        unknown
      >;
      supportedProtocolVersions?: string[];
      mcpProtocolVersion?: McpProtocolVersion;
    };
    /**
     * Per-server `mcpProtocolVersion` overrides keyed by serverId.
     * Values already passed `isKnownProtocolVersion` at the route
     * boundary (the schema validates each entry against the wire-mode
     * enum); we re-check here as a defense-in-depth so a future
     * caller bypassing the schema can't slip a typo to the SDK.
     *
     * Resolution: `mcpProtocolVersionsByServerId[serverId]` (if known)
     * → `initializePins.mcpProtocolVersion` (batch-uniform) →
     * undefined (SDK chooses at request time).
     */
    mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
    /**
     * Pre-resolved MCPJam test-IdP issuer (`resolveXaaIssuer(c, HOSTED_MODE)`)
     * for Cross-App Access servers. Supplied by callers that have the request
     * `Context`. Required whenever the batch contains a `useXaa` server — the
     * builder throws a 500 rather than connecting tokenless if it's missing.
     */
    xaaIssuer?: string;
  }
): Promise<AuthorizedManagerResult> {
  const serverNamesById = buildServerNamesById(serverIds, options?.serverNames);
  const uniqueServerIds = Array.from(new Set(serverIds));
  if (uniqueServerIds.length === 0) {
    return {
      manager: new MCPClientManager(
        {},
        {
          defaultTimeout: timeoutMs,
          rpcLogger: options?.rpcLogger,
          retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
        }
      ),
      oauthServerUrls: {},
      authenticatedUserId: null,
    };
  }

  const oauthServerUrls: Record<string, string> = {};
  const batch = await authorizeBatch(
    caller,
    bearerToken,
    projectId,
    uniqueServerIds,
    {
      accessScope: options?.accessScope,
      chatboxId: options?.chatboxId,
      accessVersion: options?.accessVersion,
    }
  );

  const configEntries = await Promise.all(
    uniqueServerIds.map(async (serverId) => {
      const auth = batch.results[serverId];
      if (!auth) {
        throw new WebRouteError(
          500,
          ErrorCode.INTERNAL_ERROR,
          `Authorization response is missing result for server "${serverId}"`
        );
      }

      if (!auth.ok) {
        throw new WebRouteError(
          auth.status,
          auth.code as ErrorCode,
          auth.message
        );
      }

      const oauthToken = auth.oauthAccessToken ?? oauthTokens?.[serverId];
      const displayServerName = serverNamesById?.[serverId] ?? serverId;
      const onUnauthorized =
        auth.serverConfig.useOAuth && auth.oauthAccessToken
          ? buildHostedOAuthUnauthorizedHandler({
              bearerToken,
              projectId,
              serverId,
              serverName: displayServerName,
              accessScope: options?.accessScope,
              shareToken: (options as { shareToken?: string })?.shareToken,
              chatboxId: options?.chatboxId,
              accessVersion: options?.accessVersion,
            })
          : undefined;

      if (auth.serverConfig.useOAuth) {
        if (auth.serverConfig.url) {
          oauthServerUrls[serverId] = auth.serverConfig.url;
        }
        if (!oauthToken) {
          throw new WebRouteError(
            401,
            ErrorCode.UNAUTHORIZED,
            `Server "${displayServerName}" requires OAuth authentication. Please complete the OAuth flow first.`,
            {
              oauthRequired: true,
              serverId,
              serverName: serverNamesById?.[serverId] ?? null,
              serverUrl: auth.serverConfig.url,
            }
          );
        }
      }

      // Cross-App Access: mint the resource access token server-side (MCPJam as
      // the test IdP) and inject it through the same `oauthAccessToken` channel
      // that sets the Bearer header. Strictly gated on `useXaa === true &&
      // useOAuth !== true` so it can never collide with the OAuth branch above.
      // The XAA token always overrides whatever the authorize batch returned: a
      // server converted from OAuth still has a stored OAuth token, and reusing
      // it would inject the wrong credential.
      let connectToken = oauthToken;
      let connectOnUnauthorized = onUnauthorized;
      const useXaa =
        auth.serverConfig.transportType === "http" &&
        auth.serverConfig.useXaa === true &&
        auth.serverConfig.useOAuth !== true;
      if (useXaa) {
        if (!options?.xaaIssuer) {
          // Caller-contract violation: a `useXaa` server reached a manager
          // builder that didn't thread the issuer (only callers holding the
          // request `Context` can resolve it). Fail loud here rather than
          // connecting tokenless and surfacing a confusing downstream 401.
          throw new WebRouteError(
            500,
            ErrorCode.INTERNAL_ERROR,
            `Missing XAA issuer for server "${displayServerName}". This connect surface must pass options.xaaIssuer.`
          );
        }
        const mintArgs = buildXaaMintArgs({
          issuer: options.xaaIssuer,
          hostedMode: HOSTED_MODE,
          serverConfig: auth.serverConfig,
          serverId,
          projectId,
          bearerToken,
          resolveServerSecret: fetchServerClientSecret,
        });
        try {
          connectToken = (await mintXaaAccessToken(mintArgs)).accessToken;
        } catch (error) {
          logger.error("[XAA connect] mint failed", error, {
            serverId,
            serverName: displayServerName,
            resource: auth.serverConfig.url,
          });
          throw error;
        }
        // Bounded re-mint: the SDK invokes this once on a 401 and retries; a
        // second 401 surfaces rather than looping mint→401→mint.
        let reMinted = false;
        connectOnUnauthorized = async () => {
          if (reMinted) {
            throw new WebRouteError(
              401,
              ErrorCode.UNAUTHORIZED,
              `Server "${displayServerName}" rejected the cross-app access token. Reconnect to retry.`
            );
          }
          reMinted = true;
          return { accessToken: (await mintXaaAccessToken(mintArgs)).accessToken };
        };
      }

      const effectiveInitializePins = resolveEffectiveInitializePinsForServer(
        serverId,
        options?.initializePins,
        options?.mcpProtocolVersionsByServerId
      );
      const authForConfig =
        auth.serverConfig.hasHeaders === true &&
        !hasNonEmptyStringRecord(auth.serverConfig.headers)
          ? {
              ...auth,
              serverConfig: {
                ...auth.serverConfig,
                headers: {
                  ...(auth.serverConfig.headers ?? {}),
                  ...((
                    await fetchRuntimeServerSecrets({
                      bearerToken,
                      projectId,
                      serverId,
                      accessScope: options?.accessScope,
                      chatboxId: options?.chatboxId,
                      accessVersion: options?.accessVersion,
                      // When the caller authed via WorkOS API key, secret
                      // reveal must use the same delegated-identity exchange
                      // as `authorizeBatch` — otherwise Convex would see the
                      // service token without an acting-as user.
                      workosApiKeyActingAs:
                        caller.authMethod === "workos_api_key" &&
                        caller.workosUserId &&
                        caller.mcpjamOrganizationId
                          ? {
                              workosUserId: caller.workosUserId,
                              mcpjamOrganizationId:
                                caller.mcpjamOrganizationId,
                            }
                          : undefined,
                    })
                  ).headers ?? {}),
                },
              },
            }
          : auth;

      return [
        serverId,
        toHttpConfig(
          authForConfig,
          timeoutMs,
          connectToken,
          clientCapabilities,
          connectOnUnauthorized,
          effectiveInitializePins
        ),
      ] as const;
    })
  );

  const manager = new MCPClientManager(Object.fromEntries(configEntries), {
    defaultTimeout: timeoutMs,
    rpcLogger: options?.rpcLogger,
    retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
  });
  return {
    manager,
    oauthServerUrls,
    authenticatedUserId: caller.getLogContext?.()?.userId ?? null,
  };
}

export async function withManager<T>(
  managerPromise: Promise<MCPClientManager> | Promise<AuthorizedManagerResult>,
  fn: (manager: MCPClientManager) => Promise<T>
): Promise<T> {
  const result = await managerPromise;
  const manager =
    "manager" in result ? result.manager : (result as MCPClientManager);
  try {
    return await fn(manager);
  } finally {
    await manager.disconnectAllServers();
  }
}

export async function handleRoute<T>(
  c: any,
  handler: () => Promise<T>,
  successStatus = 200
) {
  try {
    const result = await handler();
    return c.json(result, successStatus);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details
    );
  }
}

// ── Ephemeral Connection Helper ──────────────────────────────────────

/**
 * Resolve server IDs and OAuth tokens from parsed request body.
 *
 * Supports two shapes:
 *   - Single-server: { serverId, serverName?, oauthAccessToken? }
 *   - Multi-server:  { serverIds, serverNames?, oauthTokens? }
 */
function resolveConnectionParams(body: Record<string, unknown>): {
  serverIds: string[];
  oauthTokens: Record<string, string> | undefined;
  serverNames: string[] | undefined;
} {
  if (Array.isArray(body.serverIds)) {
    return {
      serverIds: body.serverIds as string[],
      oauthTokens: body.oauthTokens as Record<string, string> | undefined,
      serverNames: Array.isArray(body.serverNames)
        ? (body.serverNames as string[])
        : undefined,
    };
  }
  return {
    serverIds: [body.serverId as string],
    oauthTokens: buildSingleServerOAuthTokens(
      body.serverId as string,
      body.oauthAccessToken as string | undefined
    ),
    serverNames:
      typeof body.serverName === "string" && body.serverName.trim()
        ? [body.serverName]
        : undefined,
  };
}

export function extractMcpInitializeOptions(raw: Record<string, unknown>): {
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: McpProtocolVersion;
  };
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
} {
  // Extract mcpProfile.initialize.* pins so they flow into every
  // HttpServerConfig created by createAuthorizedManager. Defensive shape
  // gating: malformed fields silently fall back to SDK defaults rather
  // than failing the whole route.
  const rawClientInfo = raw.clientInfo;
  const initializeClientInfo =
    rawClientInfo &&
    typeof rawClientInfo === "object" &&
    !Array.isArray(rawClientInfo)
      ? (rawClientInfo as { name?: string; version?: string } & Record<
          string,
          unknown
        >)
      : undefined;
  const rawSupportedVersions = raw.supportedProtocolVersions;
  const initializeSupportedVersions =
    Array.isArray(rawSupportedVersions) &&
    rawSupportedVersions.every((v) => typeof v === "string" && v.length > 0)
      ? (rawSupportedVersions as string[])
      : undefined;
  const rawProtocolVersion = raw.mcpProtocolVersion;
  const initializeWireMode: McpProtocolVersion | undefined =
    typeof rawProtocolVersion === "string" &&
    isKnownProtocolVersion(rawProtocolVersion)
      ? rawProtocolVersion
      : undefined;
  const initializePins =
    initializeClientInfo || initializeSupportedVersions || initializeWireMode
      ? {
          ...(initializeClientInfo ? { clientInfo: initializeClientInfo } : {}),
          ...(initializeSupportedVersions
            ? { supportedProtocolVersions: initializeSupportedVersions }
            : {}),
          ...(initializeWireMode
            ? { mcpProtocolVersion: initializeWireMode }
            : {}),
        }
      : undefined;

  const rawProtocolVersionsByServerId = raw.mcpProtocolVersionsByServerId;
  const mcpProtocolVersionsByServerId:
    | Record<string, McpProtocolVersion>
    | undefined =
    rawProtocolVersionsByServerId &&
    typeof rawProtocolVersionsByServerId === "object" &&
    !Array.isArray(rawProtocolVersionsByServerId)
      ? (() => {
          const filtered: Record<string, McpProtocolVersion> = {};
          for (const [serverId, value] of Object.entries(
            rawProtocolVersionsByServerId as Record<string, unknown>
          )) {
            if (
              typeof serverId === "string" &&
              serverId.length > 0 &&
              typeof value === "string" &&
              isKnownProtocolVersion(value)
            ) {
              filtered[serverId] = value;
            }
          }
          return Object.keys(filtered).length > 0 ? filtered : undefined;
        })()
      : undefined;

  return {
    ...(initializePins ? { initializePins } : {}),
    ...(mcpProtocolVersionsByServerId ? { mcpProtocolVersionsByServerId } : {}),
  };
}

/**
 * Stateless per-request lifecycle: authorize → connect → execute → disconnect.
 *
 * Creates an ephemeral MCPClientManager scoped to a single request. Connections
 * are always torn down in `finally`, even on error. This is the hosted-mode
 * counterpart to the persistent singleton manager used by local /api/mcp routes.
 *
 * Handles the full request pipeline:
 *   1. Extract bearer token from Authorization header
 *   2. Parse + validate request body against the given Zod schema
 *   3. Resolve server IDs and OAuth tokens from the parsed body
 *   4. Authorize each server via Convex and create ephemeral MCP connections
 *   5. Execute `fn` with the live manager and parsed body
 *   6. Disconnect all servers (finally)
 *   7. Return JSON response (or structured error)
 *
 * Guest users and signed-in users both flow through Convex authorization. The
 * bearer token determines which backend actor owns the requested project.
 *
 * Not suitable for streaming routes (chat-v2) — those need manual lifecycle
 * management via `onStreamComplete` because the Response is returned before
 * the stream finishes.
 */
/**
 * Connection-layer core, extracted from `withEphemeralConnection` so the
 * public `/v1/*` adapters can reuse the exact same authorize -> connect -> run
 * pipeline against a body they synthesize from path params, then format the
 * result/error into the public envelope themselves. Takes an already-read
 * `rawBody`, runs `fn` against the live manager, and returns the raw result (or
 * throws a `WebRouteError`). It does NOT touch the HTTP response — callers own
 * success/error formatting (internal `webError` vs the v1 envelope).
 */
export async function runEphemeralConnection<S extends z.ZodTypeAny, T>(
  c: any,
  rawBody: Record<string, unknown>,
  schema: S,
  fn: (
    manager: InstanceType<typeof MCPClientManager>,
    body: z.infer<S>
  ) => Promise<T>,
  options?: {
    timeoutMs?: number;
    guestUnsupportedMessage?: string;
    rpcLogger?: ReturnType<typeof createHostedRpcLogCollector>["rpcLogger"];
  }
): Promise<T> {
  const { manager, body } = await createManualHostedConnection(
    c,
    rawBody,
    schema,
    options
  );

  try {
    return await fn(manager, body);
  } finally {
    await manager.disconnectAllServers();
  }
}

/**
 * Authorize and create a hosted ephemeral MCP manager without binding it to the
 * HTTP response lifecycle. Use only when the caller will keep the manager alive
 * after returning a Response, and will explicitly disconnect it when background
 * work settles.
 */
export async function createManualHostedConnection<S extends z.ZodTypeAny>(
  c: any,
  rawBody: Record<string, unknown>,
  schema: S,
  options?: {
    timeoutMs?: number;
    guestUnsupportedMessage?: string;
    rpcLogger?: ReturnType<typeof createHostedRpcLogCollector>["rpcLogger"];
  }
): Promise<{
  manager: InstanceType<typeof MCPClientManager>;
  body: z.infer<S>;
  convexAuthToken: string;
}> {
  // Both guest and signed-in actors flow through the same Convex
  // authorization path: the bearer token (guest JWT or WorkOS bearer) is
  // forwarded to /web/authorize-batch, which dispatches to the right
  // authorize* query based on the JWT issuer. Routes that legitimately
  // gate guests out (e.g. evals) opt in via `guestUnsupportedMessage`.
  if (options?.guestUnsupportedMessage && c.get("guestId")) {
    throw new WebRouteError(
      403,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      options.guestUnsupportedMessage
    );
  }

  // Under WorkOS API-key auth the raw `sk_` bearer is useless against
  // Convex's JWT-only surfaces (`/web/oauth/force-refresh` inside the
  // 401-refresh closure, reveal-secrets fallback). Swap in the short-lived
  // delegated JWT so every bearer-forwarding path downstream of
  // `createAuthorizedManager` works for API-key callers. JWT callers get
  // their original bearer back unchanged. `authorizeBatch` is unaffected
  // either way — `buildConvexAuthHeaders` branches on `authMethod`, not on
  // this value.
  const bearerToken = await getConvexBearerForRequest(c);
  const body = parseWithSchema(schema, rawBody);
  // Cast for internal plumbing — all web schemas include projectId + serverId(s).
  // The strongly-typed `body` is passed through to `fn` unchanged.
  const raw = body as Record<string, unknown>;
  const { serverIds, oauthTokens, serverNames } = resolveConnectionParams(raw);
  const timeoutMs = options?.timeoutMs ?? WEB_CALL_TIMEOUT_MS;
  const accessScope =
    raw.accessScope === "project_member" || raw.accessScope === "chat_v2"
      ? raw.accessScope
      : undefined;
  const chatboxId =
    typeof raw.chatboxId === "string" && raw.chatboxId.trim()
      ? raw.chatboxId
      : undefined;
  const accessVersion =
    typeof raw.accessVersion === "number" && Number.isFinite(raw.accessVersion)
      ? raw.accessVersion
      : undefined;
  const { initializePins, mcpProtocolVersionsByServerId } =
    extractMcpInitializeOptions(raw);

  const { manager } = await createAuthorizedManager(
    callerContextFromHono(c),
    bearerToken,
    raw.projectId as string,
    serverIds,
    timeoutMs,
    oauthTokens,
    (raw.clientCapabilities as Record<string, unknown> | undefined) ??
      undefined,
    {
      accessScope,
      chatboxId,
      accessVersion,
      rpcLogger: options?.rpcLogger,
      serverNames,
      initializePins,
      mcpProtocolVersionsByServerId,
      // Resolve the XAA issuer here (we hold the request `Context`) so the
      // manager builder can mint Cross-App Access tokens for `useXaa` servers.
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
    }
  );

  return { manager, body: body as z.infer<S>, convexAuthToken: bearerToken };
}

export async function withEphemeralConnection<S extends z.ZodTypeAny, T>(
  c: any,
  schema: S,
  fn: (
    manager: InstanceType<typeof MCPClientManager>,
    body: z.infer<S>
  ) => Promise<T>,
  options?: {
    timeoutMs?: number;
    rpcLogs?: boolean;
    guestUnsupportedMessage?: string;
  }
) {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;

  try {
    // Read body once — Hono streams can only be consumed once
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    if (options?.rpcLogs !== false) {
      rpcCollector = createHostedRpcLogCollector(rawBody);
    }

    const result = await runEphemeralConnection(c, rawBody, schema, fn, {
      timeoutMs: options?.timeoutMs,
      guestUnsupportedMessage: options?.guestUnsupportedMessage,
      rpcLogger: rpcCollector?.rpcLogger,
    });

    return c.json(attachHostedRpcLogs(result, rpcCollector), 200);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined
    );
  }
}

// Re-export commonly used error utilities for convenience
export {
  ErrorCode,
  WebRouteError,
  webError,
  parseErrorMessage,
  mapRuntimeError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
};
