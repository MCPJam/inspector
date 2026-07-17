import type { ServerWithName } from "@/hooks/use-app-state";
import { hasOAuthConfig } from "@/lib/oauth/mcp-oauth";

export function isOAuthDebuggerHeaderServer(server: ServerWithName): boolean {
  if (!("url" in server.config)) return false;
  // XAA-configured servers belong to the XAA debugger header only.
  if (server.useXaa === true) return false;
  if (server.useOAuth === true) return true;

  const hasOAuthHistory = Boolean(
    server.oauthTokens ||
      hasOAuthConfig(server.name) ||
      server.connectionStatus === "oauth-flow"
  );

  // useOAuth === false is the default for a never-touched server AND for an
  // explicit opt-out — only treat it as opt-out (and hide it) when there's
  // real history to opt out OF. Otherwise it's exactly the untouched server
  // this debugger exists to let users configure.
  if (server.useOAuth === false) return !hasOAuthHistory;

  return true; // useOAuth undefined, no signal either way — show it
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
