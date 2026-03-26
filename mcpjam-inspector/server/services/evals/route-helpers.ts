import { ConvexHttpClient } from "convex/browser";
import { MCPClientManager, type HttpServerConfig } from "@mcpjam/sdk";
import type { DiscoveredTool } from "../eval-agent.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { logger } from "../../utils/logger";

const INSPECTOR_SERVICE_TOKEN_HEADER = "X-Inspector-Service-Token";

export type ReplayConfig = {
  runId: string;
  suiteId: string;
  servers: Array<{
    serverId: string;
    url: string;
    preferSSE?: boolean;
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
  }>;
};

export async function collectToolsForServers(
  clientManager: MCPClientManager,
  serverIds: string[],
  options?: { logPrefix?: string },
): Promise<DiscoveredTool[]> {
  const logPrefix = options?.logPrefix ?? "evals";
  const perServerTools = await Promise.all(
    serverIds.map(async (serverId) => {
      if (clientManager.getConnectionStatus(serverId) !== "connected") {
        return [] as DiscoveredTool[];
      }

      try {
        const { tools } = await clientManager.listTools(serverId);
        return tools.map((tool: any) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: (tool as { outputSchema?: unknown }).outputSchema,
          serverId,
        }));
      } catch (error) {
        logger.warn(
          `[${logPrefix}] Failed to list tools for server ${serverId}`,
          {
            serverId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return [] as DiscoveredTool[];
      }
    }),
  );

  return perServerTools.flat();
}

export function createConvexClient(convexAuthToken: string) {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set");
  }

  const convexClient = new ConvexHttpClient(convexUrl);
  convexClient.setAuth(convexAuthToken);
  return convexClient;
}

export function requireConvexHttpUrl() {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  return convexHttpUrl;
}

export async function fetchReplayConfig(
  runId: string,
  userAuthToken: string,
): Promise<ReplayConfig | null> {
  const convexHttpUrl = requireConvexHttpUrl();
  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!inspectorServiceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, WEB_CALL_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `${convexHttpUrl}/internal/v1/evals/runs/replay-config`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAuthToken}`,
          [INSPECTOR_SERVICE_TOKEN_HEADER]: inspectorServiceToken,
        },
        body: JSON.stringify({ runId }),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("Timed out fetching replay config");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const body = (await response.json()) as {
    ok?: boolean;
    error?: string;
    replayConfig?: ReplayConfig | null;
  };

  if (!response.ok || !body.ok) {
    throw new Error(body.error || "Failed to fetch replay config");
  }

  return body.replayConfig ?? null;
}

export function buildReplayManager(replayConfig: ReplayConfig) {
  const entries = replayConfig.servers.map((server) => {
    const config: HttpServerConfig = {
      url: server.url,
      timeout: WEB_CALL_TIMEOUT_MS,
      ...(server.preferSSE !== undefined
        ? { preferSSE: server.preferSSE }
        : {}),
      ...(server.accessToken ? { accessToken: server.accessToken } : {}),
      ...(server.refreshToken ? { refreshToken: server.refreshToken } : {}),
      ...(server.clientId ? { clientId: server.clientId } : {}),
      ...(server.clientSecret ? { clientSecret: server.clientSecret } : {}),
    };

    return [server.serverId, config] as const;
  });

  return new MCPClientManager(Object.fromEntries(entries), {
    defaultTimeout: WEB_CALL_TIMEOUT_MS,
  });
}
