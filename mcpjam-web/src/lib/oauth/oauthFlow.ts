import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ConnectServerInput } from "../../hooks/mcpConnectionsContext";
import {
  clearPendingOAuthServer,
  createMcpOAuthProvider,
} from "./mcpOAuthProvider";

function toScope(config: ConnectServerInput): string | undefined {
  const scopes = config.oauth?.scopes;
  if (!scopes || scopes.length === 0) return undefined;
  return scopes.join(" ");
}

export async function startOAuth(
  serverId: string,
  config: ConnectServerInput,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  const provider = createMcpOAuthProvider({
    serverId,
    serverName: config.name,
    serverUrl: config.url,
    oauth: config.oauth,
  });

  return auth(provider, {
    serverUrl: config.url,
    scope: toScope(config),
  });
}

export async function finishOAuthCallback(
  serverId: string,
  config: ConnectServerInput,
  code: string,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  const provider = createMcpOAuthProvider({
    serverId,
    serverName: config.name,
    serverUrl: config.url,
    oauth: config.oauth,
  });

  const result = await auth(provider, {
    serverUrl: config.url,
    authorizationCode: code,
    scope: toScope(config),
  });

  clearPendingOAuthServer();
  return result;
}
