import type { HostedOAuthServerDescriptor } from "@/hooks/hosted/use-hosted-oauth-gate";
import type { SandboxBootstrapServer } from "@/lib/sandbox-session";

export function bootstrapServerToHostedOAuthDescriptor(
  s: SandboxBootstrapServer,
): HostedOAuthServerDescriptor {
  return {
    serverId: s.serverId,
    serverName: s.serverName,
    useOAuth: s.useOAuth,
    serverUrl: s.serverUrl,
    clientId: s.clientId,
    oauthScopes: s.oauthScopes,
    optional: Boolean(s.optional),
  };
}

export function isOptionalServerId(
  serverId: string,
  optionalServerIds: string[],
): boolean {
  return optionalServerIds.includes(serverId);
}

export function countRequiredServers(
  selectedServerIds: string[],
  optionalServerIds: string[],
): number {
  return selectedServerIds.filter((id) => !optionalServerIds.includes(id))
    .length;
}
