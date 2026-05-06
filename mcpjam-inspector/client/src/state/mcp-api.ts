import type { HttpServerConfig, MCPServerConfig } from "@mcpjam/sdk/browser";
import type { LoggingLevel } from "@modelcontextprotocol/client";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import {
  validateHostedServer,
  type HostedServerValidateResponse,
} from "@/lib/apis/web/servers-api";
import { BootstrapNotReadyError } from "@/lib/app-ready";

const HOSTED_VALIDATE_TIMEOUT_MS = 20_000;

/**
 * Extracts an OAuth access token from an HttpServerConfig's Authorization header.
 * Returns undefined if the config isn't an HTTP config or has no Bearer token.
 */
function extractOAuthToken(serverConfig: MCPServerConfig): string | undefined {
  const httpConfig = serverConfig as HttpServerConfig;
  const authHeader = (
    httpConfig?.requestInit?.headers as Record<string, string>
  )?.["Authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  return undefined;
}

function normalizeHostedValidationError(error: unknown): string {
  if (error instanceof BootstrapNotReadyError) {
    return "Hosted project is still loading. Please try again in a moment.";
  }

  if (
    error instanceof Error &&
    error.message.startsWith("Hosted server not found")
  ) {
    return "Hosted server metadata is still syncing. Please retry.";
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Hosted validation failed";
}

async function safeValidateHostedServer(
  serverId: string,
  serverConfig: MCPServerConfig,
): Promise<HostedServerValidateResponse & { error?: string }> {
  try {
    return await withTimeout(
      validateHostedServer(
        serverId,
        extractOAuthToken(serverConfig),
        serverConfig.capabilities as Record<string, unknown> | undefined,
      ),
      HOSTED_VALIDATE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      success: false,
      error: normalizeHostedValidationError(error),
    };
  }
}

// Helper to add timeout to authFetch requests
async function authFetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = 10000,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await authFetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Connection attempt timed out after ${timeoutMs / 1000} seconds. The server may not exist or is not responding.`,
      );
    }
    throw error;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          `Connection attempt timed out after ${timeoutMs / 1000} seconds. The server may not exist or is not responding.`,
        ),
      );
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

/**
 * Connection defaults that the client computed via
 * `withProjectConnectionDefaults` — project-level header overlays, request
 * timeout, and client capabilities. Forwarded through the resolver path so
 * the server can reproduce the same MCPServerConfig the legacy
 * `{serverConfig}` body would have produced. Without this, project-level
 * defaults applied client-side are lost when the resolver fetches config
 * from Convex.
 */
export type ResolverConnectionDefaults = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  clientCapabilities?: Record<string, unknown>;
};

function buildResolverBody(
  serverId: string,
  options: {
    projectId: string;
    serverName?: string;
    connectionDefaults?: ResolverConnectionDefaults;
  },
): Record<string, unknown> {
  return {
    projectId: options.projectId,
    serverId,
    ...(options.serverName ? { serverName: options.serverName } : {}),
    ...(options.connectionDefaults
      ? { connectionDefaults: options.connectionDefaults }
      : {}),
  };
}

/**
 * Local OAuth tokens currently live in localStorage (the local OAuth provider
 * has not been moved to Convex), but the resolver path expects Convex to
 * supply `oauthAccessToken` and rejects `useOAuth` servers without one. To
 * avoid breaking synced local OAuth servers, fall back to the legacy
 * `{serverConfig, serverId}` body whenever the runtime config carries a local
 * `Authorization: Bearer …` header. The legacy path forwards the header
 * straight through to the spawned client.
 */
function hasLocalOAuthBearer(serverConfig: MCPServerConfig): boolean {
  const headers = (serverConfig as { requestInit?: { headers?: unknown } })
    ?.requestInit?.headers;
  if (!headers || typeof headers !== "object") return false;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (
      key.toLowerCase() === "authorization" &&
      typeof value === "string" &&
      value.toLowerCase().startsWith("bearer ")
    ) {
      return true;
    }
  }
  return false;
}

export async function testConnection(
  serverConfig: MCPServerConfig,
  serverId: string,
  options?: {
    projectId?: string;
    serverName?: string;
    connectionDefaults?: ResolverConnectionDefaults;
  },
) {
  if (HOSTED_MODE) {
    return safeValidateHostedServer(serverId, serverConfig);
  }

  // When projectId is provided, the server resolves config + tokens from
  // Convex via /web/authorize-batch-local. Without it (or when the runtime
  // serverConfig carries a local OAuth bearer that Convex doesn't yet hold),
  // fall back to the legacy {serverConfig, serverId} body so the local token
  // travels with the request.
  const useResolver =
    !!options?.projectId && !hasLocalOAuthBearer(serverConfig);
  // The legacy server-side path uses `serverId` as the mcpClientManager key.
  // When the caller resolved a Convex `_id` for the resolver path but we end
  // up taking the legacy fallback (local OAuth bearer present), prefer the
  // display name so the manager doesn't end up with a duplicate entry keyed
  // by the Convex `_id` alongside the existing display-name entry.
  const legacyServerId = options?.serverName ?? serverId;
  const body: Record<string, unknown> = useResolver
    ? buildResolverBody(serverId, {
        projectId: options!.projectId!,
        serverName: options?.serverName,
        connectionDefaults: options?.connectionDefaults,
      })
    : { serverConfig, serverId: legacyServerId };

  const res = await authFetchWithTimeout(
    "/api/mcp/connect",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    20000, // 20 second timeout
  );
  return res.json();
}

export async function deleteServer(serverId: string) {
  if (HOSTED_MODE) {
    void serverId;
    return { success: true };
  }

  const res = await authFetch(
    `/api/mcp/servers/${encodeURIComponent(serverId)}`,
    {
      method: "DELETE",
    },
  );
  return res.json();
}

export async function listServers() {
  if (HOSTED_MODE) {
    return { success: true, servers: [] };
  }

  const res = await authFetch("/api/mcp/servers");
  return res.json();
}

export async function reconnectServer(
  serverId: string,
  serverConfig: MCPServerConfig,
  options?: {
    projectId?: string;
    serverName?: string;
    connectionDefaults?: ResolverConnectionDefaults;
  },
) {
  if (HOSTED_MODE) {
    return safeValidateHostedServer(serverId, serverConfig);
  }

  const useResolver =
    !!options?.projectId && !hasLocalOAuthBearer(serverConfig);
  // See testConnection: prefer the display name for the legacy body so we
  // don't create a phantom mcpClientManager entry keyed by the Convex `_id`.
  const legacyServerId = options?.serverName ?? serverId;
  const body: Record<string, unknown> = useResolver
    ? buildResolverBody(serverId, {
        projectId: options!.projectId!,
        serverName: options?.serverName,
        connectionDefaults: options?.connectionDefaults,
      })
    : { serverId: legacyServerId, serverConfig };

  const res = await authFetchWithTimeout(
    "/api/mcp/servers/reconnect",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    20000, // 20 second timeout
  );
  return res.json();
}

export async function getInitializationInfo(serverId: string) {
  if (HOSTED_MODE) {
    // In hosted mode, init info is returned inline from /validate.
    // This fallback only runs if the validate response lacked initInfo.
    return { success: true, initInfo: null };
  }

  const res = await authFetch(
    `/api/mcp/servers/init-info/${encodeURIComponent(serverId)}`,
  );
  return res.json();
}

export async function setServerLoggingLevel(
  serverId: string,
  level: LoggingLevel,
) {
  if (HOSTED_MODE) {
    void serverId;
    void level;
    return {
      success: false,
      error: "Server logging level is not supported in hosted mode",
    };
  }

  const res = await authFetch("/api/mcp/log-level", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, level }),
  });
  return res.json();
}
