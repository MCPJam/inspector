import { MCPServerConfig } from "@mcpjam/sdk";
import type { HttpServerConfig } from "@mcpjam/sdk";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import {
  validateHostedServer,
  getHostedInitializationInfo,
  type HostedServerValidateResponse,
} from "@/lib/apis/web/servers-api";

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
  if (
    error instanceof Error &&
    error.message === "Hosted workspace is not available yet"
  ) {
    return "Hosted workspace is still loading. Please try again in a moment.";
  }

  if (
    error instanceof Error &&
    error.message.startsWith("Hosted server not found for ")
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
    return await validateHostedServer(
      serverId,
      extractOAuthToken(serverConfig),
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

export async function testConnection(
  serverConfig: MCPServerConfig,
  serverId: string,
) {
  if (HOSTED_MODE) {
    return safeValidateHostedServer(serverId, serverConfig);
  }

  const res = await authFetchWithTimeout(
    "/api/mcp/connect",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverConfig, serverId }),
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
) {
  if (HOSTED_MODE) {
    return safeValidateHostedServer(serverId, serverConfig);
  }

  const res = await authFetchWithTimeout(
    "/api/mcp/servers/reconnect",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, serverConfig }),
    },
    20000, // 20 second timeout
  );
  return res.json();
}

export async function getInitializationInfo(serverId: string) {
  if (HOSTED_MODE) {
    return getHostedInitializationInfo(serverId);
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
