import { createContext, useContext } from "react";

/**
 * Signals that the current React subtree renders a session whose MCP
 * servers are Convex-resolved and reachable only through the hosted
 * `/api/web/*` routes — on every platform, not just hosted builds.
 *
 * Provided by the published chatbox runtime (`ChatboxChatPage`) for
 * redeemed share-link sessions: their server set comes from the chatbox's
 * host config (Convex ids + Convex-held secrets), so the local
 * `/api/mcp/*` branch — which resolves servers from this browser
 * session's connection pool — can never connect them. Consumers
 * (widget-content fetch, MCP-Apps bridge resource/prompt handlers) use
 * this to pick the hosted API branch where the build-level `HOSTED_MODE`
 * flag alone would wrongly route to the local pool.
 *
 * Deliberately NOT set for playground builder previews: in local builds
 * those reuse the builder's locally-connected servers, where the local
 * branch is correct.
 *
 * `false` (the default) preserves platform routing for every other
 * surface (Connect → Chat, eval editors, playground, …).
 */
const WebManagedServersContext = createContext<boolean>(false);

export const WebManagedServersProvider = WebManagedServersContext.Provider;

export function useWebManagedServers(): boolean {
  return useContext(WebManagedServersContext);
}
