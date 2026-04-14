import { ConvexHttpClient } from "convex/browser";
import {
  MCPClientManager,
  type HttpServerConfig,
  type MCPServerReplayConfig,
} from "@mcpjam/sdk";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  buildServerToolSnapshotDebug,
  exportConnectedServerToolSnapshotForEvalAuthoring,
} from "../../utils/export-helpers.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";

const INSPECTOR_SERVICE_TOKEN_HEADER = "X-Inspector-Service-Token";

export type ReplayConfig = {
  runId: string;
  suiteId: string;
  servers: MCPServerReplayConfig[];
};

export async function captureToolSnapshotForEvalAuthoring(
  clientManager: MCPClientManager,
  serverIds: string[],
  options?: { logPrefix?: string; promptSectionMaxChars?: number },
) {
  const toolSnapshot = await exportConnectedServerToolSnapshotForEvalAuthoring(
    clientManager,
    serverIds,
    {
      logPrefix: options?.logPrefix,
    },
  );

  return {
    toolSnapshot,
    toolSnapshotDebug: buildServerToolSnapshotDebug(toolSnapshot, {
      maxChars: options?.promptSectionMaxChars,
    }),
  };
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

export async function storeReplayConfig(
  runId: string,
  serverReplayConfigs: MCPServerReplayConfig[],
  userAuthToken: string,
): Promise<void> {
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
      `${convexHttpUrl}/internal/v1/evals/runs/store-replay-config`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAuthToken}`,
          [INSPECTOR_SERVICE_TOKEN_HEADER]: inspectorServiceToken,
        },
        body: JSON.stringify({ runId, serverReplayConfigs }),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("Timed out storing replay config");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const body = (await response.json()) as {
    ok?: boolean;
    error?: string;
  };

  if (!response.ok || !body.ok) {
    throw new Error(body.error || "Failed to store replay config");
  }
}

export function replayManagerServerEntries(
  replayConfig: ReplayConfig,
): Array<[string, HttpServerConfig]> {
  return replayConfig.servers.map((server) => {
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
}

export function buildReplayManager(replayConfig: ReplayConfig) {
  return new MCPClientManager(
    Object.fromEntries(replayManagerServerEntries(replayConfig)),
    {
      defaultTimeout: WEB_CALL_TIMEOUT_MS,
      lazyConnect: true,
      retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
    },
  );
}

function isMcpAlreadyConnectedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already connected");
}

/**
 * Await MCP connections for all replay servers. The manager constructor starts
 * connects in the background; failed connects clear only live state while
 * preserving registered server inventory. Explicit connect ensures replay
 * runners see a stable connection or a clear connection error before making
 * follow-on SDK calls.
 */
export async function connectReplayManagerServers(
  manager: MCPClientManager,
  replayConfig: ReplayConfig,
): Promise<void> {
  const entries = replayManagerServerEntries(replayConfig);
  await Promise.all(
    entries.map(async ([serverId, config]) => {
      try {
        await manager.connectToServer(serverId, config);
      } catch (error) {
        if (isMcpAlreadyConnectedError(error)) {
          return;
        }
        throw error;
      }
    }),
  );
}
