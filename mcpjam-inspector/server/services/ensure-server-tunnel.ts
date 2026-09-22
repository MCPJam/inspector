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
import { tunnelManager, type TunnelScope } from "./tunnel-manager";
import { withTunnelLock } from "./tunnel-locks";
import { fetchRelayGrant } from "./tunnel-grants";
import { LOCAL_SERVER_ADDR } from "../config";

/**
 * Shared ensure flow for both scopes: existing tunnel → return as-is;
 * otherwise mint a Convex relay grant for the scope and open the relay socket.
 */
async function ensureScopedTunnel(
  serverId: string,
  scope: TunnelScope | undefined,
  authHeader?: string,
): Promise<string> {
  return withTunnelLock(scope ? `${scope} ${serverId}` : serverId, async () => {
    const existing = tunnelManager.getServerTunnelUrl(serverId, scope);
    if (existing) return existing;

    const grant = await fetchRelayGrant(serverId, authHeader, scope);
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
      scope,
    );
    // Prefer the live entry; fall back to the grant URL if a permanent edge
    // close raced in right after createTunnel (mirrors routes/mcp/tunnels.ts).
    return tunnelManager.getServerTunnelUrl(serverId, scope) ?? grant.url;
  });
}

export async function ensureServerTunnel(
  serverId: string,
  authHeader?: string,
): Promise<string> {
  return ensureScopedTunnel(serverId, undefined, authHeader);
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
  return ensureScopedTunnel(serverId, "harness-web", authHeader);
}
