import { webPost } from "./base";
import type { OAuthConnection } from "@/shared/oauth-connections";
export const OAUTH_CONNECTIONS_CHANGED = "mcpjam:oauth-connections-changed";
export function notifyOAuthConnectionsChanged() {
  window.dispatchEvent(new Event(OAUTH_CONNECTIONS_CHANGED));
}
export async function listOAuthConnections(
  projectId: string,
  serverId: string,
) {
  const result = await webPost<
    unknown,
    { connections: OAuthConnection[]; shared?: boolean }
  >("/api/web/oauth/connections", { projectId, serverId });
  return {
    connections: result.connections ?? [],
    shared: result.shared === true,
  };
}
export async function updateOAuthConnection(
  projectId: string,
  serverId: string,
  connectionId: string,
  operation: "label" | "default" | "delete",
  label?: string,
) {
  const result = await webPost<unknown, { found?: boolean; outcome?: string }>(
    `/api/web/oauth/connections/${operation}`,
    {
      projectId,
      serverId,
      connectionId,
      ...(label !== undefined ? { label } : {}),
    },
  );
  if (
    result.found === false ||
    result.outcome === "missing" ||
    result.outcome === "stale"
  )
    throw new Error(
      "The connection changed. Refresh the account list and try again.",
    );
  notifyOAuthConnectionsChanged();
}
export async function captureHostedOAuthConnection(
  projectId: string,
  serverId: string,
  connectionId?: string,
  expectedVaultObjectId?: string,
) {
  if (!connectionId || !expectedVaultObjectId) return;
  try {
    await webPost("/api/web/oauth/connections/profile", {
      projectId,
      serverId,
      connectionId,
      expectedVaultObjectId,
    });
  } finally {
    notifyOAuthConnectionsChanged();
  }
}
