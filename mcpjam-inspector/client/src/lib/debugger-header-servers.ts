import type { ServerWithName } from "@/hooks/use-app-state";
import { hasOAuthConfig } from "@/lib/oauth/mcp-oauth";

export function isOAuthDebuggerHeaderServer(server: ServerWithName): boolean {
  if (!("url" in server.config)) return false;
  // XAA-configured servers belong to the XAA debugger header only.
  if (server.useXaa === true) return false;
  if (server.useOAuth === false) return false;

  return Boolean(
    server.useOAuth === true ||
      server.oauthTokens ||
      hasOAuthConfig(server.name) ||
      server.connectionStatus === "oauth-flow"
  );
}

export function isXaaDebuggerHeaderServer(server: ServerWithName): boolean {
  return "url" in server.config && server.useXaa === true;
}

export function hasDebuggerHeaderServers({
  serverConfigs,
  hiddenServers,
  includeXaaServers = false,
}: {
  serverConfigs: Record<string, ServerWithName>;
  hiddenServers?: ReadonlySet<string>;
  includeXaaServers?: boolean;
}): boolean {
  return Object.entries(serverConfigs).some(([name, server]) => {
    if (hiddenServers?.has(name)) return false;
    return (
      isOAuthDebuggerHeaderServer(server) ||
      (includeXaaServers && isXaaDebuggerHeaderServer(server))
    );
  });
}
