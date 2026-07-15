/**
 * Ensure a per-server relay tunnel is live and return its public bearer URL
 * (`https://{slug}.tunnels.mcpjam.com/api/mcp/adapter-http/{serverId}?k=…`).
 *
 * Extracted from `routes/mcp/tunnels.ts` so the harness turn (always-proxy)
 * and the web tunnel route share one idempotent code path: existing tunnel →
 * return as-is; otherwise mint a Convex relay grant and open the relay socket.
 * Serialized per server via the same tunnel lock the route uses, so concurrent
 * callers (a chat turn + the UI) don't race the edge's view of the live grant.
 */
import { tunnelManager } from "./tunnel-manager";
import { withTunnelLock } from "./tunnel-locks";
import { fetchRelayGrant } from "./tunnel-grants";
import { LOCAL_SERVER_ADDR } from "../config";

export async function ensureServerTunnel(
  serverId: string,
  authHeader?: string,
): Promise<string> {
  return withTunnelLock(serverId, async () => {
    const existing = tunnelManager.getServerTunnelUrl(serverId);
    if (existing) return existing;

    const grant = await fetchRelayGrant(serverId, authHeader);
    await tunnelManager.createTunnel(serverId, {
      localAddr: LOCAL_SERVER_ADDR,
      slug: grant.slug,
      relayWsUrl: grant.relayWsUrl,
      connectToken: grant.connectToken,
      publicUrl: grant.url,
      secretVersion: grant.secretVersion,
    });
    // Prefer the live entry; fall back to the grant URL if a permanent edge
    // close raced in right after createTunnel (mirrors routes/mcp/tunnels.ts).
    return tunnelManager.getServerTunnelUrl(serverId) ?? grant.url;
  });
}

/**
 * Like `ensureServerTunnel`, but for the `harness-web` scope: returns a bearer
 * URL bound to `/api/web/harness-mcp/{serverId}` instead of the adapter path.
 * Used by the hosted harness proxy strategy when the inspector is private (local
 * dev / self-hosted) and can't be reached directly by the cloud sandbox. The
 * tunnel coexists with any adapter-http tunnel for the same server (independent
 * slug/secret/lock).
 */
export async function ensureHarnessWebTunnel(
  serverId: string,
  authHeader?: string,
): Promise<string> {
  return withTunnelLock(`harness-web ${serverId}`, async () => {
    const existing = tunnelManager.getServerTunnelUrl(serverId, "harness-web");
    if (existing) return existing;

    const grant = await fetchRelayGrant(serverId, authHeader, "harness-web");
    await tunnelManager.createTunnel(
      serverId,
      {
        localAddr: LOCAL_SERVER_ADDR,
        slug: grant.slug,
        relayWsUrl: grant.relayWsUrl,
        connectToken: grant.connectToken,
        publicUrl: grant.url,
        secretVersion: grant.secretVersion,
      },
      "harness-web",
    );
    return (
      tunnelManager.getServerTunnelUrl(serverId, "harness-web") ?? grant.url
    );
  });
}
