import type { Context } from "hono";
import type { MCPServerConfig } from "@mcpjam/sdk";
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";
import { setRequestLogContext } from "./request-logger.js";
import {
  type InternalLogContext,
  mapInternalToRequestContext,
} from "./internal-log-context.js";
import type { ConnectionDefaults } from "../../shared/connection-defaults.js";

type LocalAuthorizeServerConfig =
  | {
      transportType: "http";
      url: string;
      headers: Record<string, string>;
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
    AUTHORIZE_BATCH_LOCAL_TIMEOUT_MS,
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
      (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR");
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
    for (const [k, v] of Object.entries(input.headers as Record<string, unknown>)) {
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
    out.clientCapabilities = input.clientCapabilities as Record<string, unknown>;
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
      `Server config has an invalid URL: ${serverConfig.url}`,
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
): Promise<{ config: MCPServerConfig; authorizeResult: LocalAuthorizeBatchSuccess }> {
  const result = await authorizeServerLocal(c, bearerToken, projectId, serverId);

  const useOAuth =
    result.serverConfig.transportType === "http" &&
    result.serverConfig.useOAuth === true;
  if (useOAuth && !result.oauthAccessToken) {
    const displayName = options?.serverDisplayName ?? serverId;
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      `Server "${displayName}" requires OAuth authentication. Please complete the OAuth flow first.`,
      {
        oauthRequired: true,
        serverId,
        serverName: options?.serverDisplayName ?? null,
        serverUrl:
          result.serverConfig.transportType === "http"
            ? result.serverConfig.url
            : undefined,
      }
    );
  }

  const config = toMCPServerConfig(result, {
    timeoutMs: options?.timeoutMs ?? options?.defaults?.timeoutMs,
    clientCapabilities:
      options?.clientCapabilities ?? options?.defaults?.clientCapabilities,
    defaultHeaders: options?.defaults?.headers,
  });
  return { config, authorizeResult: result };
}
