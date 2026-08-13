import type { HostedOAuthServerDescriptor } from "@/hooks/hosted/use-hosted-oauth-gate";
import type { ChatboxBootstrapServer } from "@/lib/chatbox-session";

export function bootstrapServerToHostedOAuthDescriptor(
  s: ChatboxBootstrapServer,
): HostedOAuthServerDescriptor {
  return {
    serverId: s.serverId,
    serverName: s.serverName,
    useOAuth: s.useOAuth,
    serverUrl: s.serverUrl,
    clientId: s.clientId,
    oauthScopes: s.oauthScopes,
    oauthProtocolMode: s.oauthProtocolMode,
    oauthProtocolVersion: s.oauthProtocolVersion,
    wireProtocolVersion: s.wireProtocolVersion,
    // Threaded rather than dropped: the hosted authorization builds the same
    // request as a local connect, and silently omitting these is what made the
    // two disagree.
    oauthResourceUrl: s.oauthResourceUrl,
    hasClientSecret: s.hasClientSecret,
    oauthCustomHeaders: s.oauthCustomHeaders,
    oauthAllowPathScopedIssuer: s.oauthAllowPathScopedIssuer,
    registrationMode: s.registrationMode,
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
