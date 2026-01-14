import type { ServerWithName, ConnectionStatus } from "@/state/app-types";

export function serializeServersForSharing(
  servers: Record<string, ServerWithName>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [serverId, server] of Object.entries(servers)) {
    const serializedServer: Record<string, unknown> = {
      name: server.name,
      enabled: server.enabled,
      useOAuth: server.useOAuth,
    };

    if (server.config) {
      const config: Record<string, unknown> = {};

      if ((server.config as any).url) {
        config.url =
          (server.config as any).url instanceof URL
            ? (server.config as any).url.href
            : (server.config as any).url;
      }
      if ((server.config as any).command)
        config.command = (server.config as any).command;
      if ((server.config as any).args)
        config.args = (server.config as any).args;
      if ((server.config as any).timeout)
        config.timeout = (server.config as any).timeout;

      if ((server.config as any).requestInit) {
        const requestInit: Record<string, unknown> = {};
        if ((server.config as any).requestInit.headers) {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            (server.config as any).requestInit.headers,
          )) {
            if (key.toLowerCase() !== "authorization") {
              headers[key] = value as string;
            }
          }
          requestInit.headers = headers;
        }
        config.requestInit = requestInit;
      }

      serializedServer.config = config;
    }

    if (server.useOAuth && server.oauthFlowProfile) {
      serializedServer.oauthFlowProfile = {
        serverUrl: server.oauthFlowProfile.serverUrl,
        protocolVersion: server.oauthFlowProfile.protocolVersion,
        registrationStrategy: server.oauthFlowProfile.registrationStrategy,
        scopes: server.oauthFlowProfile.scopes,
        clientId: server.oauthFlowProfile.clientId,
      };
    }

    result[serverId] = serializedServer;
  }

  return result;
}

export function deserializeServersFromConvex(
  servers: Record<string, any>,
): Record<string, ServerWithName> {
  const result: Record<string, ServerWithName> = {};

  for (const [serverId, serverData] of Object.entries(servers)) {
    if (!serverData) continue;

    const config: any = {};
    if (serverData.config) {
      if (serverData.config.url) {
        try {
          config.url = new URL(serverData.config.url);
        } catch {
          config.url = serverData.config.url;
        }
      }
      if (serverData.config.command) config.command = serverData.config.command;
      if (serverData.config.args) config.args = serverData.config.args;
      if (serverData.config.env) config.env = serverData.config.env;
      if (serverData.config.timeout) config.timeout = serverData.config.timeout;
      if (serverData.config.requestInit)
        config.requestInit = serverData.config.requestInit;
    }

    const server: ServerWithName = {
      name: serverData.name || serverId,
      config,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected" as ConnectionStatus,
      retryCount: 0,
      enabled: serverData.enabled ?? false,
      useOAuth: serverData.useOAuth ?? false,
    };

    if (serverData.oauthFlowProfile) {
      server.oauthFlowProfile = serverData.oauthFlowProfile;
    }

    result[serverId] = server;
  }

  return result;
}

export function serversHaveChanged(
  local: Record<string, ServerWithName>,
  remote: Record<string, any>,
): boolean {
  const localKeys = Object.keys(local);
  const remoteKeys = Object.keys(remote);

  if (localKeys.length !== remoteKeys.length) return true;

  for (const key of localKeys) {
    if (!remoteKeys.includes(key)) return true;

    const localServer = local[key];
    const remoteServer = remote[key];

    if (localServer.name !== remoteServer.name) return true;
    if (localServer.enabled !== remoteServer.enabled) return true;
    if (localServer.useOAuth !== remoteServer.useOAuth) return true;

    const localUrl =
      (localServer.config as any)?.url?.toString?.() ||
      (localServer.config as any)?.url;
    const remoteUrl = remoteServer.config?.url;
    if (localUrl !== remoteUrl) return true;

    if ((localServer.config as any)?.command !== remoteServer.config?.command)
      return true;
    if (
      JSON.stringify((localServer.config as any)?.args) !==
      JSON.stringify(remoteServer.config?.args)
    )
      return true;
    if ((localServer.config as any)?.timeout !== remoteServer.config?.timeout)
      return true;
    if (
      JSON.stringify((localServer.config as any)?.requestInit) !==
      JSON.stringify(remoteServer.config?.requestInit)
    )
      return true;
    if (
      JSON.stringify((localServer.config as any)?.env) !==
      JSON.stringify(remoteServer.config?.env)
    )
      return true;
    if (
      JSON.stringify(localServer.oauthFlowProfile) !==
      JSON.stringify(remoteServer.oauthFlowProfile)
    )
      return true;
  }

  return false;
}
