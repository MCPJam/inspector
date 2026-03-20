import type { ConnectionStatus } from "@/state/app-types";
import { authFetch } from "@/lib/session-token";
import { runByMode } from "@/lib/apis/mode-client";

export type ServerHealthResponse =
  | {
      success: true;
      serverId: string;
      connectionStatus: ConnectionStatus | string;
      healthStatus: "healthy";
      latencyMs: number;
      checkedAt: string;
    }
  | {
      success: false;
      serverId: string;
      connectionStatus: ConnectionStatus | string;
      healthStatus: "unhealthy";
      checkedAt: string;
      latencyMs?: number;
      error: string;
    };

export async function getServerHealth(
  serverId: string,
): Promise<ServerHealthResponse> {
  return runByMode({
    hosted: async () => ({
      success: false,
      serverId,
      connectionStatus: "connected",
      healthStatus: "unhealthy",
      checkedAt: new Date().toISOString(),
      error: "Server health checks are only available in local mode",
    }),
    local: async () => {
      const res = await authFetch(
        `/api/mcp/servers/status/${encodeURIComponent(serverId)}`,
      );

      let body: ServerHealthResponse | null = null;
      try {
        body = (await res.json()) as ServerHealthResponse;
      } catch {}

      if (body) {
        return body;
      }

      return {
        success: false,
        serverId,
        connectionStatus: "disconnected",
        healthStatus: "unhealthy",
        checkedAt: new Date().toISOString(),
        error: res.ok
          ? "Server health check returned an empty response"
          : `Server health check failed (${res.status})`,
      };
    },
  });
}
