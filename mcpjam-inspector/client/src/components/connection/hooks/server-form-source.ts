import type { ServerWithName } from "@/state/app-types";
import { getRedactedConfigFlag } from "../server-auth";

// Compare the saved inputs that can change the form, including URL values
// recreated by server sync. Connection results and token refreshes are runtime
// state and should not discard a draft or hide values the editor revealed.
// OAuth scopes and client IDs learned from tokens or local storage alone are
// read on the next form initialization, such as when the editor reopens.
export function getServerFormSource(server: ServerWithName) {
  const { config, oauthFlowProfile } = server;
  return {
    name: server.name,
    publishedPluginId: server.publishedPluginId ?? "",
    url: "url" in config ? config.url?.toString() : undefined,
    command: config.command,
    args: config.args,
    env: config.env,
    headers: "url" in config ? config.requestInit?.headers : undefined,
    timeout: config.timeout,
    capabilities: config.clientCapabilities ?? config.capabilities,
    hasClientSecret: server.hasClientSecret === true,
    hasBearerToken:
      server.hasBearerToken === true ||
      getRedactedConfigFlag(config, "hasBearerToken"),
    hasHeaders:
      server.hasHeaders === true ||
      getRedactedConfigFlag(config, "hasHeaders"),
    hasEnv: server.hasEnv === true || getRedactedConfigFlag(config, "hasEnv"),
    authMethod: server.authMethod,
    useOAuth: server.useOAuth === true,
    useXaa: server.useXaa === true,
    oauthProtocolMode: server.oauthProtocolMode,
    registrationMode: server.registrationMode,
    scopes: oauthFlowProfile?.scopes,
    clientId: oauthFlowProfile?.clientId,
    profileProtocol: oauthFlowProfile?.protocolVersion,
    profileRegistration: oauthFlowProfile?.registrationStrategy,
    xaaClientAuth: server.xaaClientAuth,
    xaaAuthzIssuer: server.xaaAuthzIssuer,
    xaaAllowPathScopedIssuer: server.xaaAllowPathScopedIssuer === true,
    oauthAllowPathScopedIssuer: server.oauthAllowPathScopedIssuer === true,
    xaaSubject: server.xaaSubject,
    xaaEmail: server.xaaEmail,
  };
}
