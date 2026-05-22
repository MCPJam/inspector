import { z } from "zod";
import type { Context } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
import type {
  HttpServerConfig,
  RpcLogger,
  UnauthorizedRefreshHandler,
} from "@mcpjam/sdk";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  attachHostedRpcLogs,
  createHostedRpcLogCollector,
} from "./hosted-rpc-logs.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { setRequestLogContext } from "../../utils/request-logger.js";
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
import {
  buildHostedOAuthUnauthorizedHandler,
} from "../../utils/hosted-oauth-refresh.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

const clientCapabilitiesSchema = z.record(z.string(), z.unknown());

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
    useOAuth?: boolean;
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
  T extends { serverConfig?: Record<string, unknown> },
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
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
  return stripStdioFieldsFromHostedConfig(clientSafe) as ClientSafeAuthorizeResponse;
}

export async function authorizeBatch(
  c: Context,
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        projectId,
        serverIds,
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
    setRequestLogContext(c, partial);
  }

  const strippedResults: Record<string, ConvexBatchAuthorizeResult> = {};
  for (const [serverId, result] of Object.entries(raw.results)) {
    if (result.ok) {
      const { internalLogContext: _omit, ...clientSafeResult } = result;
      strippedResults[serverId] = stripStdioFieldsFromHostedConfig(
        clientSafeResult,
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
  };
}

export interface AuthorizedManagerResult {
  manager: MCPClientManager;
  /** Maps serverId → serverUrl for servers that have useOAuth enabled */
  oauthServerUrls: Record<string, string>;
}

export async function createAuthorizedManager(
  c: Context,
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
     * mcpProfile.initialize.* pins, applied uniformly to every
     * authorized server in this batch. The same pins flow into every
     * HttpServerConfig because hosted batches resolve under one
     * profile context — we don't currently support per-server
     * mcpProfile overrides.
     */
    initializePins?: {
      clientInfo?: { name?: string; version?: string } & Record<
        string,
        unknown
      >;
      supportedProtocolVersions?: string[];
    };
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
    };
  }

  const oauthServerUrls: Record<string, string> = {};
  const batch = await authorizeBatch(
    c,
    bearerToken,
    projectId,
    uniqueServerIds,
    {
      accessScope: options?.accessScope,
      chatboxId: options?.chatboxId,
      accessVersion: options?.accessVersion,
    }
  );

  const configEntries = uniqueServerIds.map((serverId) => {
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

    return [
      serverId,
      toHttpConfig(
        auth,
        timeoutMs,
        oauthToken,
        clientCapabilities,
        onUnauthorized,
        options?.initializePins
      ),
    ] as const;
  });

  const manager = new MCPClientManager(Object.fromEntries(configEntries), {
    defaultTimeout: timeoutMs,
    rpcLogger: options?.rpcLogger,
    retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
  });
  return { manager, oauthServerUrls };
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

    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(schema, rawBody);
    // Cast for internal plumbing — all web schemas include projectId + serverId(s).
    // The strongly-typed `body` is passed through to `fn` unchanged.
    const raw = body as Record<string, unknown>;
    const { serverIds, oauthTokens, serverNames } =
      resolveConnectionParams(raw);
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

    // Extract mcpProfile.initialize.* pins so they flow into every
    // HttpServerConfig created by createAuthorizedManager. The schema
    // (projectServerSchema or any extension thereof) declares
    // `clientInfo` / `supportedProtocolVersions` as optional fields —
    // when present, the client has resolved them from the active
    // hostConfig and wants the hosted route to honor them on
    // `initialize`. Defensive shape gating: only forward an object
    // `clientInfo` and only a non-empty string array for
    // `supportedProtocolVersions`. A malformed payload silently falls
    // back to SDK defaults rather than failing the whole route.
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
    const initializePins =
      initializeClientInfo || initializeSupportedVersions
        ? {
            ...(initializeClientInfo
              ? { clientInfo: initializeClientInfo }
              : {}),
            ...(initializeSupportedVersions
              ? { supportedProtocolVersions: initializeSupportedVersions }
              : {}),
          }
        : undefined;

    const result = await withManager(
      createAuthorizedManager(
        c,
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
          rpcLogger: rpcCollector?.rpcLogger,
          serverNames,
          initializePins,
        }
      ),
      (manager) => fn(manager, body as z.infer<S>)
    );

    return c.json(attachHostedRpcLogs(result, rpcCollector), 200);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope()
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
