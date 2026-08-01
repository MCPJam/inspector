/**
 * Harness MCP proxy *plane strategy* — selected by the CALLER ROUTE, never by a
 * global env. `/api/web/chat-v2` is a hosted-plane request even in local dev
 * (it builds an ephemeral authorized manager), so reading `HOSTED_MODE` inside
 * the turn would route the sandbox to the wrong manager. The route passes this
 * strategy through `MCPJamHandlerOptions.harnessMcpProxy`; the turn asks it only
 * for the per-server URL (the token is minted by Convex — see
 * `harness-proxy-token-client.ts` — so no identity rides the strategy).
 *
 * - `local-mcp`            → sandbox reaches the private inspector via a
 *                            per-server tunnel, landing on
 *                            `/api/mcp/adapter-http/{id}`.
 * - `web-authorized direct`→ sandbox reaches a PUBLIC inspector directly at
 *                            `{publicBaseUrl}/api/web/harness-mcp/{id}`.
 * - `web-authorized relay` → inspector is PRIVATE (local dev / self-hosted) and
 *                            unreachable from the cloud sandbox, so it's exposed
 *                            via a scoped `harness-web` tunnel whose edge only
 *                            permits `/api/web/harness-mcp/{id}`.
 */
import {
  ensureServerTunnel,
  ensureHarnessWebTunnel,
} from "../../services/ensure-server-tunnel.js";
import { isPubliclyReachableUrl } from "../localhost-check.js";

export type HarnessMcpProxyStrategy =
  | { plane: "local-mcp" }
  | {
      plane: "web-authorized";
      mode: "direct";
      /** Server-authoritative PUBLIC origin of the inspector's `/api/web`. */
      publicBaseUrl: string;
    }
  | { plane: "web-authorized"; mode: "relay" };

/**
 * Decide how the cloud sandbox reaches THIS inspector's `/api/web/harness-mcp`
 * for a hosted (`/api/web`) harness turn — a single **deploy-topology** call,
 * no extra env knob: is the inspector publicly reachable?
 *  - a publicly-reachable `MCPJAM_INSPECTOR_PUBLIC_URL`/`BASE_URL` → **direct**
 *    (cloud prod; a configured public self-host);
 *  - otherwise (no URL, loopback, or RFC1918/private) the inspector is private
 *    — local dev (`dev:hosted`) or self-hosted-behind-a-firewall — so the cloud
 *    sandbox reaches it through the scoped **harness-web relay**.
 * Still fail-closed where it matters: if relay infra isn't configured,
 * `ensureHarnessWebTunnel` throws at tunnel-creation with a concrete error.
 */
export function resolveWebAuthorizedHarnessStrategy(): HarnessMcpProxyStrategy {
  const publicUrl =
    process.env.MCPJAM_INSPECTOR_PUBLIC_URL?.trim() ||
    process.env.BASE_URL?.trim();
  if (publicUrl && isPubliclyReachableUrl(publicUrl)) {
    return { plane: "web-authorized", mode: "direct", publicBaseUrl: publicUrl };
  }
  return { plane: "web-authorized", mode: "relay" };
}

/**
 * Resolve the `.mcp.json` URL for one server. `local-mcp` ensures the
 * adapter-http tunnel; `web-authorized` either points at the public route
 * directly or ensures a scoped `harness-web` tunnel (whose bearer URL already
 * carries the `/api/web/harness-mcp/{id}` path + `?k=`).
 */
export async function resolveHarnessProxyUrl(args: {
  strategy: HarnessMcpProxyStrategy;
  serverId: string;
  authHeader: string;
}): Promise<string> {
  const { strategy, serverId, authHeader } = args;
  if (strategy.plane === "web-authorized") {
    if (strategy.mode === "direct") {
      const base = strategy.publicBaseUrl.replace(/\/+$/, "");
      return `${base}/api/web/harness-mcp/${encodeURIComponent(serverId)}`;
    }
    return ensureHarnessWebTunnel(serverId, authHeader);
  }
  // local-mcp: reach the private inspector through the per-server adapter tunnel.
  return ensureServerTunnel(serverId, authHeader);
}
