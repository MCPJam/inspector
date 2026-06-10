import type { Context } from "hono";
import type { MCPClientManager, MCPServerConfig } from "@mcpjam/sdk";
import {
  describeError,
  isKnownProtocolVersionPin,
  type McpProtocolVersionPin,
} from "@mcpjam/sdk";
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";
import {
  buildHostedOAuthUnauthorizedHandler,
  forceRefreshHostedOAuthAccessToken,
} from "./hosted-oauth-refresh.js";
import { logger } from "./logger.js";
import { exportSingleServerForInspection } from "./export-helpers.js";
import { ConvexHttpClient } from "convex/browser";
import { getInspectorClientRuntimeConfig } from "../env.js";
import { setRequestLogContext } from "./request-logger.js";
import {
  type InternalLogContext,
  mapInternalToRequestContext,
} from "./internal-log-context.js";
import { fetchRuntimeServerSecrets } from "./server-secrets.js";
import type { ConnectionDefaults } from "../../shared/connection-defaults.js";

type LocalAuthorizeServerConfig =
  | {
      transportType: "http";
      url: string;
      headers: Record<string, string>;
      hasHeaders?: boolean;
      timeout?: number;
      clientCapabilities?: unknown;
      useOAuth?: boolean;
      oauthScopes?: string[];
      clientId?: string;
      oauthResourceUrl?: string;
    }
  | {
      transportType: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      hasEnv?: boolean;
      timeout?: number;
      clientCapabilities?: unknown;
    };

type LocalAuthorizeBatchSuccess = {
  ok: true;
  role: string;
  accessLevel: string;
  permissions: { chatOnly: boolean };
  serverConfig: LocalAuthorizeServerConfig;
  oauthAccessToken?: string | null;
  internalLogContext?: InternalLogContext;
};

type LocalAuthorizeBatchFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type LocalAuthorizeBatchResult =
  | LocalAuthorizeBatchSuccess
  | LocalAuthorizeBatchFailure;

export type LocalAuthorizeBatchResponse = {
  results: Record<string, LocalAuthorizeBatchResult>;
};

/**
 * Read the WorkOS or guest bearer the client attached to a /api/mcp/* request.
 * Local mode runs both `X-MCP-Session-Auth` (loopback secret, checked by
 * sessionAuthMiddleware) AND `Authorization: Bearer ...` (Convex actor identity).
 * The session token alone gates access to the local API process; Convex itself
 * still enforces project ownership via the bearer.
 */
export function readLocalApiBearer(c: Context): string | null {
  const raw = c.req.header("Authorization") ?? c.req.header("authorization");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

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

/**
 * Call Convex `/web/authorize-batch-local` with the user's bearer.
 * Returns the full server config for each requested serverId, including
 * STDIO command/args/env. Hosted-only fields (share/chatbox tokens) are not
 * accepted by this endpoint by design.
 */
export async function authorizeBatchLocal(
  c: Context,
  bearerToken: string,
  projectId: string,
  serverIds: string[]
): Promise<LocalAuthorizeBatchResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  // Cap the call so a hung Convex instance can't tie up the inspector worker
  // for the inbound /api/mcp/connect or /api/mcp/servers/reconnect request.
  // 10s is well above the 99p of the underlying authorize* query and below
  // most browser/proxy idle timeouts.
  const AUTHORIZE_BATCH_LOCAL_TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    AUTHORIZE_BATCH_LOCAL_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize-batch-local`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ projectId, serverIds }),
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error as { code?: string }).code === "ABORT_ERR");
    throw new WebRouteError(
      isAbort ? 504 : 502,
      ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `Authorization service timed out after ${AUTHORIZE_BATCH_LOCAL_TIMEOUT_MS}ms`
        : `Failed to reach authorization service: ${parseErrorMessage(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
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

  const raw = body as LocalAuthorizeBatchResponse;
  const successful = Object.entries(raw.results).filter(
    (entry): entry is [string, LocalAuthorizeBatchSuccess] => entry[1].ok
  );
  const sourceCtx = successful.find(([, r]) => r.internalLogContext)?.[1]
    .internalLogContext;
  if (sourceCtx) {
    const partial = mapInternalToRequestContext(sourceCtx);
    if (successful.length > 1) {
      // Multi-server batch: a single per-server identifier on the request log
      // line would be misleading. Null them out so the line aggregates over
      // the batch instead.
      partial.serverId = null;
      partial.serverTransport = null;
      partial.chatboxId = null;
    }
    setRequestLogContext(c, partial);
  }

  // Strip internalLogContext from results so it never leaks downstream.
  const stripped: Record<string, LocalAuthorizeBatchResult> = {};
  for (const [serverId, result] of Object.entries(raw.results)) {
    if (result.ok) {
      const { internalLogContext: _omit, ...clean } = result;
      stripped[serverId] = clean;
    } else {
      stripped[serverId] = result;
    }
  }
  return { results: stripped };
}

/**
 * Convenience wrapper: authorize a single server and return the {success: true}
 * payload directly. Throws WebRouteError for any non-ok result.
 */
export async function authorizeServerLocal(
  c: Context,
  bearerToken: string,
  projectId: string,
  serverId: string
): Promise<LocalAuthorizeBatchSuccess> {
  const batch = await authorizeBatchLocal(c, bearerToken, projectId, [
    serverId,
  ]);
  const result = batch.results[serverId];
  if (!result) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      `Authorization response is missing result for server "${serverId}"`
    );
  }
  if (!result.ok) {
    throw new WebRouteError(
      result.status,
      result.code as ErrorCode,
      result.message
    );
  }
  return result;
}

// Header precedence (lowest → highest) when the resolver merges these
// onto Convex-stored server config: Convex-stored server headers, project
// default headers from `defaults.headers`, OAuth `Authorization` (if the
// server uses OAuth), so OAuth always wins.

/**
 * Validate `connectionDefaults` from an /api/mcp/* request body. Returns
 * `undefined` for missing/non-object input so the caller can fall back to
 * Convex-stored values. Drops any fields that aren't of the expected shape
 * rather than rejecting the whole request — defaults are advisory.
 */
export function parseConnectionDefaults(
  raw: unknown
): ConnectionDefaults | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const out: ConnectionDefaults = {};

  if (input.headers && typeof input.headers === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      input.headers as Record<string, unknown>
    )) {
      if (typeof v === "string") headers[k] = v;
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
  }

  if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)) {
    out.timeoutMs = input.timeoutMs;
  }

  if (
    input.clientCapabilities &&
    typeof input.clientCapabilities === "object"
  ) {
    out.clientCapabilities = input.clientCapabilities as Record<
      string,
      unknown
    >;
  }

  // Accept clientInfo as a plain object (not null/array/scalar). Drop on
  // shape mismatch rather than reject — a malformed payload shouldn't kill
  // the whole connect request. Extras-only objects (`{ title: "..." }`
  // without name/version) survive this gate because the upstream MCP
  // Client backfills name/version from manager defaults; gating on
  // name/version presence here used to silently drop forward-compat
  // payloads where the host only wanted to pin `title` or future spec
  // fields.
  if (
    input.clientInfo &&
    typeof input.clientInfo === "object" &&
    !Array.isArray(input.clientInfo)
  ) {
    const ci = input.clientInfo as Record<string, unknown>;
    // Require at least one own enumerable key so a literal `{}` doesn't
    // hash distinctly from "field omitted" in downstream wire logs.
    if (Object.keys(ci).length > 0) {
      out.clientInfo = ci as ConnectionDefaults["clientInfo"];
    }
  }

  // Accept the full supportedProtocolVersions array. Filter to non-empty
  // trimmed strings — preserves order (semantic per the SDK contract:
  // `supportedProtocolVersions[0]` is what the SDK proposes). Drop the
  // field entirely if no valid entries remain.
  if (Array.isArray(input.supportedProtocolVersions)) {
    const versions = input.supportedProtocolVersions
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    if (versions.length > 0) {
      out.supportedProtocolVersions = versions;
    }
  }

  // Pinned MCP protocol version. Membership-gate against
  // MCP_PROTOCOL_VERSIONS at this trust boundary (per the
  // validate-then-route discipline) so typo strings drop to undefined
  // instead of slipping through to the factory's open-routing
  // predicate.
  if (
    typeof input.mcpProtocolVersion === "string" &&
    isKnownProtocolVersionPin(input.mcpProtocolVersion)
  ) {
    out.mcpProtocolVersion = input.mcpProtocolVersion;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build an `MCPServerConfig` (the SDK's union of stdio + http configs) from a
 * local authorize result. Distinct from hosted's `toHttpConfig` which strips
 * STDIO and rejects non-HTTPS — this is the unstripped local-mode equivalent.
 */
export function toMCPServerConfig(
  authResult: LocalAuthorizeBatchSuccess,
  options?: {
    timeoutMs?: number;
    oauthAccessToken?: string;
    clientCapabilities?: Record<string, unknown>;
    defaultHeaders?: Record<string, string>;
    /**
     * Identity needed to attach the SDK's `onUnauthorized` 401-recovery hook
     * for hosted-OAuth servers. When all four are present and the server has
     * a hosted OAuth token, the hook calls Convex `/web/oauth/force-refresh`
     * with this same bearer to mint a fresh token without prompting reconnect.
     * Header-only HTTP servers and stdio servers never get the hook.
     */
    refreshContext?: {
      bearerToken: string;
      projectId: string;
      serverId: string;
      serverName: string;
    };
    /**
     * Per-connection MCP `initialize.params.clientInfo` override resolved
     * from `hostConfig.mcpProfile.initialize.clientInfo`. Undefined means
     * "use SDK defaults" (the inspector's hardcoded clientInfo). Forwarded
     * verbatim to MCPClientManager so extra fields (`title`, future spec
     * additions) survive without an SDK bump.
     */
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    /**
     * Per-connection supported protocol versions accept-list, resolved
     * verbatim from `hostConfig.mcpProfile.initialize.supportedProtocolVersions`.
     * Undefined means "use SDK defaults" — the upstream Client falls back
     * to its built-in `SUPPORTED_PROTOCOL_VERSIONS`. When set, the SDK
     * sends `supportedProtocolVersions[0]` as
     * `initialize.params.protocolVersion` and uses the full list as the
     * accept-set; a server negotiating any listed version is accepted, an
     * unlisted version fails fast.
     */
    supportedProtocolVersions?: string[];
    /**
     * Resolved per-server pinned MCP protocol version —
     * `resolveEffectiveMcpProtocolVersion` already applied (server
     * override > host default > undefined). Forwarded only for HTTP
     * configs; the SDK factory throws `StatelessRequiresHttpTransport`
     * for stdio when the pin is stateless, so we silently skip on stdio
     * rather than crash a non-HTTP server config a user toggled the
     * host default on for.
     */
    mcpProtocolVersion?: McpProtocolVersionPin;
  }
): MCPServerConfig {
  const { serverConfig } = authResult;
  const timeout = options?.timeoutMs ?? serverConfig.timeout;
  const clientCapabilities =
    options?.clientCapabilities ??
    (serverConfig.clientCapabilities as Record<string, unknown> | undefined);

  if (serverConfig.transportType === "stdio") {
    const stdio: any = {
      command: serverConfig.command,
      args: serverConfig.args ?? [],
      env: serverConfig.env ?? {},
    };
    if (typeof timeout === "number") stdio.timeout = timeout;
    if (clientCapabilities) {
      stdio.capabilities = clientCapabilities;
      stdio.clientCapabilities = clientCapabilities;
    }
    // mcpProfile.initialize fields flow into the SDK's per-server config.
    // Undefined skips the field entirely so callers that don't opt in stay
    // byte-identical to historical behavior on the wire.
    if (options?.clientInfo) stdio.clientInfo = options.clientInfo;
    if (
      options?.supportedProtocolVersions &&
      options.supportedProtocolVersions.length > 0
    ) {
      stdio.supportedProtocolVersions = options.supportedProtocolVersions;
    }
    return stdio as MCPServerConfig;
  }

  // Header precedence for HTTP servers: Convex-stored server headers form the
  // base, project-default headers from the runtime `defaultHeaders` overlay
  // them (so org/project policy can add headers without touching individual
  // server records), and a bearer for OAuth-using servers always wins because
  // it carries the actor identity.
  const headers: Record<string, string> = {
    ...(serverConfig.headers ?? {}),
    ...(options?.defaultHeaders ?? {}),
  };
  const oauthToken = options?.oauthAccessToken ?? authResult.oauthAccessToken;
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
  }

  // Match the legacy connect-path shape: legacy `connect.ts` upgrades the
  // URL string to a `URL` object before calling `connectToServer`, and any
  // downstream code (HOSTED_MODE protocol checks, future SDK / middleware
  // logic that does `instanceof URL` or accesses `.protocol`/`.hostname`)
  // has been validated against that shape. Passing a string here would be
  // silent drift between the two paths.
  let url: URL;
  try {
    url = new URL(serverConfig.url);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Server config has an invalid URL: ${serverConfig.url}`
    );
  }

  const http: any = {
    url,
    requestInit: { headers },
  };
  if (typeof timeout === "number") http.timeout = timeout;
  if (clientCapabilities) {
    http.capabilities = clientCapabilities;
    http.clientCapabilities = clientCapabilities;
  }
  // mcpProfile.initialize fields — same opt-in shape as the stdio branch.
  if (options?.clientInfo) http.clientInfo = options.clientInfo;
  if (
    options?.supportedProtocolVersions &&
    options.supportedProtocolVersions.length > 0
  ) {
    http.supportedProtocolVersions = options.supportedProtocolVersions;
  }
  // Outbound wire mode — only forwarded for HTTP configs (the SDK
  // factory rejects stateless on stdio at construction time). Undefined
  // = SDK default (legacy upstream Client + initialize).
  if (options?.mcpProtocolVersion)
    http.mcpProtocolVersion = options.mcpProtocolVersion;

  // Attach the SDK's 401-recovery hook only when this is a hosted-OAuth
  // server (we have a token from `authorize-batch-local`) AND the caller
  // supplied refresh context. Header-only HTTP servers can't be refreshed
  // server-side, so the hook would be a no-op there.
  if (oauthToken && serverConfig.useOAuth === true && options?.refreshContext) {
    http.onUnauthorized = buildHostedOAuthUnauthorizedHandler({
      bearerToken: options.refreshContext.bearerToken,
      projectId: options.refreshContext.projectId,
      serverId: options.refreshContext.serverId,
      serverName: options.refreshContext.serverName,
    });
  }

  return http as MCPServerConfig;
}

/**
 * Single-call convenience: authorize a serverId and return both the raw
 * response (for OAuth token plumbing) and a ready-to-pass MCPServerConfig.
 * Throws WebRouteError for unauthorized / not found / OAuth-required cases.
 */
export async function resolveLocalServerForConnect(
  c: Context,
  bearerToken: string,
  projectId: string,
  serverId: string,
  options?: {
    timeoutMs?: number;
    clientCapabilities?: Record<string, unknown>;
    serverDisplayName?: string;
    /**
     * Runtime defaults the inspector client computed via
     * `withProjectConnectionDefaults` and forwarded explicitly so the
     * resolver can reproduce the same MCPServerConfig the legacy
     * `{serverConfig}` body would have produced. Without this, project-level
     * header/timeout/capability defaults applied client-side are lost on the
     * resolver path.
     */
    defaults?: ConnectionDefaults;
  }
): Promise<{
  config: MCPServerConfig;
  authorizeResult: LocalAuthorizeBatchSuccess;
}> {
  let result = await authorizeServerLocal(c, bearerToken, projectId, serverId);

  const useOAuth =
    result.serverConfig.transportType === "http" &&
    result.serverConfig.useOAuth === true;
  // Track the access token we'll hand to `toMCPServerConfig`. Starts from
  // whatever `authorize-batch-local` returned, but for hosted-OAuth servers
  // we fall back to a server-side refresh — same `force-refresh` endpoint
  // the chat path's `onUnauthorized` hook uses — when the batch returned
  // empty. Without this, an expired access token aborts the reconnect with
  // a 401 *before* the SDK gets a chance to attach `onUnauthorized`, so
  // auto-connect and the manual reconnect toggle would stay disconnected
  // even though sending a chat message works (chat goes through the same
  // refresh helper for in-flight 401s).
  let resolvedOauthAccessToken: string | undefined =
    result.oauthAccessToken ?? undefined;
  if (useOAuth && !resolvedOauthAccessToken) {
    const displayName = options?.serverDisplayName ?? serverId;
    try {
      resolvedOauthAccessToken = await forceRefreshHostedOAuthAccessToken(
        bearerToken,
        projectId,
        serverId,
        { serverName: displayName }
      );
    } catch (error) {
      const refreshTokenInvalid =
        error instanceof WebRouteError &&
        Boolean(
          (error.details as { refreshTokenInvalid?: boolean } | undefined)
            ?.refreshTokenInvalid
        );
      if (!refreshTokenInvalid) {
        // Transient (rate limit, network, backend 5xx). Bubble up so the
        // UI / caller can retry rather than telling the user to reconnect.
        throw error;
      }
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        `Server "${displayName}" requires OAuth authentication. Please complete the OAuth flow first.`,
        {
          oauthRequired: true,
          refreshTokenInvalid: true,
          serverId,
          serverName: options?.serverDisplayName ?? null,
          serverUrl:
            result.serverConfig.transportType === "http"
              ? result.serverConfig.url
              : undefined,
        }
      );
    }
  }

  const needsRuntimeSecrets =
    (result.serverConfig.transportType === "stdio" &&
      result.serverConfig.hasEnv === true &&
      !hasNonEmptyStringRecord(result.serverConfig.env)) ||
    (result.serverConfig.transportType === "http" &&
      result.serverConfig.hasHeaders === true &&
      !hasNonEmptyStringRecord(result.serverConfig.headers));
  if (needsRuntimeSecrets) {
    const secrets = await fetchRuntimeServerSecrets({
      bearerToken,
      projectId,
      serverId,
    });
    result = {
      ...result,
      serverConfig:
        result.serverConfig.transportType === "stdio"
          ? {
              ...result.serverConfig,
              env: secrets.env ?? result.serverConfig.env ?? {},
            }
          : {
              ...result.serverConfig,
              headers: {
                ...(result.serverConfig.headers ?? {}),
                ...(secrets.headers ?? {}),
              },
            },
    };
  }

  const config = toMCPServerConfig(result, {
    timeoutMs: options?.timeoutMs ?? options?.defaults?.timeoutMs,
    clientCapabilities:
      options?.clientCapabilities ?? options?.defaults?.clientCapabilities,
    defaultHeaders: options?.defaults?.headers,
    // mcpProfile.initialize fields ride through ConnectionDefaults end-to-end:
    // client computes them from hostConfig.mcpProfile, wire-serializes onto
    // /api/mcp/connect, parseConnectionDefaults gates the shape, and they
    // land on the per-server SDK config here. Undefined preserves
    // historical wire behavior — no opt-in, no change.
    clientInfo: options?.defaults?.clientInfo,
    supportedProtocolVersions: options?.defaults?.supportedProtocolVersions,
    // Same opt-in path for the wire mode — `resolveEffectiveMcpProtocolVersion`
    // runs client-side, the literal is wire-serialized via
    // ConnectionDefaults, and lands on the SDK config here.
    mcpProtocolVersion: options?.defaults?.mcpProtocolVersion,
    oauthAccessToken: resolvedOauthAccessToken,
    refreshContext: {
      bearerToken,
      projectId,
      serverId,
      serverName: options?.serverDisplayName ?? serverId,
    },
  });
  return { config, authorizeResult: result };
}

// ---------------------------------------------------------------------------
// Connect-flow plumbing shared by /api/mcp/connect + /api/mcp/servers/reconnect
// ---------------------------------------------------------------------------
//
// The two local connect endpoints used to inline ~120 lines each of body
// parsing + WebRouteError translation + tolerant disconnect/connect, with
// drift accumulating between them (different success envelopes, neither
// returning `initInfo` — see the reconnect-warning false-positive bug).
// These helpers consolidate that flow and bring the success envelope shape
// in line with hosted `/api/web/servers/validate`.

/**
 * Parsed + validated body for the local connect/reconnect endpoints. Strict
 * about the resolver-path fields because both endpoints now require them
 * (the legacy `{serverConfig}` body was removed in the local-mode purge).
 */
export interface LocalConnectRequestParams {
  serverId: string;
  projectId: string;
  serverDisplayName: string;
  bearer: string;
  clientCapabilities?: Record<string, unknown>;
  defaults?: ConnectionDefaults;
}

/**
 * Validate a JSON body posted to the local connect/reconnect endpoints.
 * Returns parsed params on success, or a `WebRouteError` whose status the
 * caller passes straight to `c.json` — no other branching needed.
 *
 * Doesn't throw on validation issues so callers don't have to differentiate
 * between auth/format errors and config-resolve errors (which DO throw via
 * `resolveLocalServerForConnect`).
 */
export function parseLocalConnectRequestBody(
  c: Context,
  body: unknown
):
  | { ok: true; params: LocalConnectRequestParams }
  | { ok: false; error: WebRouteError } {
  const raw = (body ?? {}) as Record<string, unknown>;

  const serverId = typeof raw.serverId === "string" ? raw.serverId.trim() : "";
  if (!serverId) {
    return {
      ok: false,
      error: new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "serverId is required"
      ),
    };
  }

  const projectId =
    typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  if (!projectId) {
    return {
      ok: false,
      error: new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required"
      ),
    };
  }

  const serverDisplayName =
    typeof raw.serverName === "string" ? raw.serverName.trim() : "";
  if (!serverDisplayName) {
    return {
      ok: false,
      error: new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "serverName is required with projectId"
      ),
    };
  }

  const bearer = readLocalApiBearer(c);
  if (!bearer) {
    return {
      ok: false,
      error: new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Authorization bearer token is required"
      ),
    };
  }

  const clientCapabilities =
    typeof raw.clientCapabilities === "object" &&
    raw.clientCapabilities !== null
      ? (raw.clientCapabilities as Record<string, unknown>)
      : undefined;

  return {
    ok: true,
    params: {
      serverId,
      projectId,
      serverDisplayName,
      bearer,
      clientCapabilities,
      defaults: parseConnectionDefaults(raw.connectionDefaults),
    },
  };
}

/**
 * Translate a `WebRouteError` into the error envelope local-mode handlers
 * have always returned (`{success: false, error, ...details}`), and tag
 * OAuth-required 401s with the `X-MCP-Auth-Required` header so the client's
 * `authFetch` doesn't waste a guest-session refresh round-trip on a failure
 * the next attempt would inevitably repeat.
 *
 * Distinct from `webError` (used by the hosted routes): hosted returns a
 * `{code, message, details}` shape; local has historically used
 * `{success: false, error, ...details}` and clients depend on that.
 */
export function respondWithLocalRouteError(c: Context, error: WebRouteError) {
  if (error.details?.oauthRequired === true) {
    c.header("X-MCP-Auth-Required", "oauth");
  }
  const normalized = error.normalized ?? describeError(error);
  return c.json(
    {
      success: false,
      error: error.message,
      ...(error.details ?? {}),
      normalized,
    },
    error.status as any
  );
}

/**
 * Standard success envelope for local connect/reconnect responses. Mirrors
 * the hosted `/api/web/servers/validate` shape so the inspector client's
 * `storeInitInfo(name, result.initInfo)` takes the synchronous-dispatch
 * path on both surfaces — no second `/api/mcp/servers/init-info` round-trip
 * for the warning indicator to race against.
 *
 * `initInfo` is `null` (not omitted) when the manager has no live state
 * yet, so the client can distinguish "server connected but init data not
 * available" from "field missing because old server forgot to include it."
 */
export function buildConnectSuccessEnvelope(
  manager: Pick<MCPClientManager, "getInitializationInfo">,
  managerKey: string
): { success: true; status: "connected"; initInfo: unknown } {
  return {
    success: true,
    status: "connected",
    initInfo: manager.getInitializationInfo(managerKey) ?? null,
  };
}

/**
 * Tolerant disconnect-then-connect plus init-info pickup, shared by both
 * local connect endpoints. `removeOnFailure` cleans up the manager entry
 * after a failed connect (used by /api/mcp/connect for first-time connects
 * so a doomed entry doesn't pollute subsequent listServers calls);
 * /reconnect leaves the entry around since the caller intends to retry.
 *
 * Throws via the supplied `c.json` machinery — callers `return` the result.
 * Tests assert a specific success envelope shape; if you change it here,
 * sync the inspector client's `storeInitInfo` callsites and the connect/
 * reconnect tests in `server/routes/mcp/__tests__`.
 */
export async function executeLocalServerConnect(
  c: Context,
  params: LocalConnectRequestParams,
  options: { removeOnFailure: boolean }
) {
  const { serverId, projectId, serverDisplayName, bearer } = params;
  const mcpClientManager = c.mcpClientManager;

  let resolved: Awaited<ReturnType<typeof resolveLocalServerForConnect>>;
  try {
    resolved = await resolveLocalServerForConnect(
      c,
      bearer,
      projectId,
      serverId,
      {
        serverDisplayName,
        clientCapabilities: params.clientCapabilities,
        defaults: params.defaults,
      }
    );
  } catch (error) {
    if (error instanceof WebRouteError) {
      return respondWithLocalRouteError(c, error);
    }
    logger.error("Error resolving server config", error, { serverId });
    return c.json(
      {
        success: false,
        error: "Failed to resolve server config",
        details: error instanceof Error ? error.message : "Unknown error",
        normalized: describeError(error),
      },
      500
    );
  }

  // Tolerate "nothing to disconnect" — first-time connects have nothing in
  // the manager yet, and stale-or-already-disconnected entries on reconnect
  // shouldn't fail the call. Same tolerance as the legacy DELETE handler.
  try {
    await mcpClientManager.disconnectServer(serverDisplayName);
  } catch (disconnectError) {
    logger.debug("Failed to disconnect MCP server before connect", {
      serverId: serverDisplayName,
      error:
        disconnectError instanceof Error
          ? disconnectError.message
          : String(disconnectError),
    });
  }

  try {
    await mcpClientManager.connectToServer(serverDisplayName, resolved.config);
  } catch (error) {
    if (options.removeOnFailure) {
      try {
        await mcpClientManager.removeServer(serverDisplayName);
      } catch (cleanupError) {
        logger.debug("Failed to remove MCP server after connection failure", {
          serverId: serverDisplayName,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
      }
    }
    return c.json(
      {
        success: false,
        error: `Connection failed for server ${serverDisplayName}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        details: error instanceof Error ? error.message : "Unknown error",
        normalized: describeError(error),
      },
      500
    );
  }

  // Capture the inspection snapshot synchronously so a fast follow-up
  // disconnect/reconnect on the same server can't tear down the manager
  // mid-`listTools`. Only the Convex write is fire-and-forget — failures
  // there never affect the connect response (the connect succeeded
  // regardless). Port of PR #1731's `use-inspection-coordinator`; mirrors
  // the hosted `/web/servers/validate` path.
  const inspectionSnapshot = await exportSingleServerForInspection(
    mcpClientManager,
    serverDisplayName,
    serverId,
    { logPrefix: "connect-inspection" }
  );
  void persistConnectInspection({
    convexBearer: bearer,
    projectId,
    snapshot: inspectionSnapshot,
  }).catch((error) => {
    logger.debug("Failed to persist connect-time inspection", {
      serverId: serverDisplayName,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return c.json(
    buildConnectSuccessEnvelope(mcpClientManager, serverDisplayName)
  );
}

async function persistConnectInspection(args: {
  convexBearer: string | undefined;
  projectId: string;
  snapshot: Awaited<ReturnType<typeof exportSingleServerForInspection>>;
}): Promise<void> {
  // Only `CONVEX_HTTP_URL` is boot-enforced; the convex-client URL is
  // derived from it (suffix swap) by the runtime config helper so that
  // production env (which sets only CONVEX_HTTP_URL) works.
  const { convexUrl } = getInspectorClientRuntimeConfig();
  if (!convexUrl || !args.convexBearer) {
    return;
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(args.convexBearer);
  await client.mutation("serverInspections:recordFromConnect" as any, {
    projectId: args.projectId,
    snapshot: args.snapshot,
  });
}
