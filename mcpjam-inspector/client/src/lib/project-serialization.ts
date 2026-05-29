import type { ServerWithName, ConnectionStatus } from "@/state/app-types";

type SerializeOptions = {
  /**
   * When true, drop secret-bearing fields (STDIO `env`, HTTP
   * `Authorization` headers) from the output. When false, keep them
   * verbatim.
   *
   * Sharing payloads MUST redact: STDIO `env` commonly carries API
   * keys / DB credentials, and HTTP `Authorization` carries bearers.
   * Persistence payloads (the legacy localStorage → Convex migration)
   * MUST preserve these — without them, a migrated STDIO server is
   * non-functional and the user has to re-enter every credential, and
   * an HTTP server configured with a static `Authorization` header
   * (self-hosted MCP with a long-lived bearer, etc.) silently fails
   * to reconnect after migration clears the legacy localStorage copy.
   */
  redactSecrets: boolean;
};

function serializeServersInternal(
  servers: Record<string, ServerWithName>,
  options: SerializeOptions
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
      if (!options.redactSecrets && (server.config as any).env)
        config.env = (server.config as any).env;
      if ((server.config as any).timeout)
        config.timeout = (server.config as any).timeout;
      if ((server.config as any).clientCapabilities)
        config.clientCapabilities = (server.config as any).clientCapabilities;

      if ((server.config as any).requestInit) {
        const requestInit: Record<string, unknown> = {};
        if ((server.config as any).requestInit.headers) {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            (server.config as any).requestInit.headers
          )) {
            if (
              options.redactSecrets &&
              key.toLowerCase() === "authorization"
            ) {
              continue;
            }
            headers[key] = value as string;
          }
          requestInit.headers = headers;
        }
        config.requestInit = requestInit;
      }

      serializedServer.config = config;
    }

    if (server.useOAuth && server.oauthFlowProfile) {
      // OAuthTestProfile.scopes is a UI-shaped string ("read,write" or
      // "read write"); the Convex `servers.oauthScopes` field is
      // v.array(v.string()). Split here so syncProjectServers can pass the
      // value straight through without tripping schema validation.
      const rawScopes = server.oauthFlowProfile.scopes;
      const scopesArray = Array.isArray(rawScopes)
        ? (rawScopes as string[])
        : typeof rawScopes === "string"
        ? rawScopes.split(/[\s,]+/).filter(Boolean)
        : [];
      serializedServer.oauthFlowProfile = {
        serverUrl: server.oauthFlowProfile.serverUrl,
        resourceUrl: server.oauthFlowProfile.resourceUrl,
        protocolVersion: server.oauthFlowProfile.protocolVersion,
        registrationStrategy: server.oauthFlowProfile.registrationStrategy,
        scopes: scopesArray,
        clientId: server.oauthFlowProfile.clientId,
      };
    }

    result[serverId] = serializedServer;
  }

  return result;
}

/**
 * Serialize servers for an outbound share/invite payload (`ShareProjectDialog`,
 * `use-project-state` clone-to-org / fork flows). Drops STDIO `env` so secrets
 * stay on the local machine.
 */
export function serializeServersForSharing(
  servers: Record<string, ServerWithName>
): Record<string, unknown> {
  return serializeServersInternal(servers, { redactSecrets: true });
}

/**
 * Serialize servers for in-account persistence — currently only the
 * legacy-localStorage → Convex migration. Preserves STDIO `env` because the
 * migration target is the same actor's own Convex project (not a share
 * recipient), and dropping env would leave migrated STDIO servers
 * non-functional.
 *
 * Do NOT use this for any share/export/invite payload. If a future feature
 * needs to copy a project across actors, route it through
 * `serializeServersForSharing`.
 */
export function serializeServersForPersistence(
  servers: Record<string, ServerWithName>
): Record<string, unknown> {
  return serializeServersInternal(servers, { redactSecrets: false });
}

export function deserializeServersFromConvex(
  servers: Record<string, any> | any[]
): Record<string, ServerWithName> {
  const result: Record<string, ServerWithName> = {};

  // Handle array (from servers table) or object (legacy project.servers)
  const entries = Array.isArray(servers)
    ? servers.map((s) => [s.name, s] as [string, any])
    : Object.entries(servers);

  for (const [serverId, serverData] of entries) {
    if (!serverData) continue;

    const config: any = {};

    // NEW: Read from flat fields (servers table)
    if (serverData.url) {
      try {
        config.url = new URL(serverData.url);
      } catch {
        config.url = serverData.url;
      }
    }
    if (serverData.command) config.command = serverData.command;
    if (serverData.args) config.args = serverData.args;
    if (serverData.env) config.env = serverData.env;
    if (serverData.timeout) config.timeout = serverData.timeout;
    if (serverData.clientCapabilities) {
      config.clientCapabilities = serverData.clientCapabilities;
    }
    if (serverData.headers) {
      config.requestInit = { headers: serverData.headers };
    }

    // LEGACY: Also check nested config (backward compat with project.servers)
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
      if (serverData.config.clientCapabilities)
        config.clientCapabilities = serverData.config.clientCapabilities;
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
      hasClientSecret: serverData.hasClientSecret === true,
      hasEnv: serverData.hasEnv === true,
      hasHeaders: serverData.hasHeaders === true,
    };

    // Handle oauthFlowProfile from legacy nested structure
    if (serverData.oauthFlowProfile) {
      server.oauthFlowProfile = serverData.oauthFlowProfile;
    }

    // NEW: Handle flat oauthScopes/clientId from servers table
    // Convert oauthScopes array to comma-separated string for OAuthTestProfile.scopes
    if (
      serverData.oauthScopes ||
      serverData.clientId ||
      serverData.hasClientSecret ||
      serverData.oauthResourceUrl
    ) {
      const existingProfile = (server.oauthFlowProfile as any) || {};
      server.oauthFlowProfile = {
        ...existingProfile,
        scopes: Array.isArray(serverData.oauthScopes)
          ? serverData.oauthScopes.join(",")
          : existingProfile.scopes || "",
        clientId: serverData.clientId || existingProfile.clientId || "",
        clientSecret:
          serverData.hasClientSecret === true
            ? ""
            : existingProfile.clientSecret || "",
        resourceUrl:
          serverData.oauthResourceUrl || existingProfile.resourceUrl || "",
      } as typeof server.oauthFlowProfile;
    }

    result[serverId] = server;
  }

  return result;
}

export function serversHaveChanged(
  local: Record<string, ServerWithName>,
  remote: Record<string, any> | any[]
): boolean {
  // Handle array (from servers table) or object (legacy)
  const remoteRecord = Array.isArray(remote)
    ? Object.fromEntries(remote.map((s) => [s.name, s]))
    : remote;

  const localKeys = Object.keys(local);
  const remoteKeys = Object.keys(remoteRecord);

  if (localKeys.length !== remoteKeys.length) return true;

  for (const key of localKeys) {
    if (!remoteKeys.includes(key)) return true;

    const localServer = local[key];
    const remoteServer = remoteRecord[key];

    if (localServer.name !== remoteServer.name) return true;
    if (localServer.enabled !== remoteServer.enabled) return true;
    if (localServer.useOAuth !== remoteServer.useOAuth) return true;

    // Get local URL
    const localUrl =
      (localServer.config as any)?.url?.toString?.() ||
      (localServer.config as any)?.url;

    // Get remote URL (flat field or nested config)
    const remoteUrl = remoteServer.url || remoteServer.config?.url;
    if (localUrl !== remoteUrl) return true;

    // Get remote command (flat field or nested config)
    const remoteCommand = remoteServer.command || remoteServer.config?.command;
    if ((localServer.config as any)?.command !== remoteCommand) return true;

    // Get remote args (flat field or nested config)
    const remoteArgs = remoteServer.args || remoteServer.config?.args;
    if (
      JSON.stringify((localServer.config as any)?.args) !==
      JSON.stringify(remoteArgs)
    )
      return true;

    // Get remote timeout (flat field or nested config)
    const remoteTimeout = remoteServer.timeout || remoteServer.config?.timeout;
    if ((localServer.config as any)?.timeout !== remoteTimeout) return true;

    const remoteClientCapabilities =
      remoteServer.clientCapabilities ||
      remoteServer.config?.clientCapabilities;
    if (
      JSON.stringify((localServer.config as any)?.clientCapabilities) !==
      JSON.stringify(remoteClientCapabilities)
    )
      return true;

    // Get remote requestInit/headers (flat headers or nested config.requestInit)
    const remoteRequestInit = remoteServer.headers
      ? { headers: remoteServer.headers }
      : remoteServer.config?.requestInit;
    const remoteHasHeaders = remoteServer.hasHeaders === true;
    const localHasHiddenHeaders =
      localServer.hasHeaders === true &&
      (localServer.config as any)?.requestInit === undefined;
    if (!remoteHasHeaders || !localHasHiddenHeaders) {
      if (
        JSON.stringify((localServer.config as any)?.requestInit) !==
        JSON.stringify(remoteRequestInit)
      )
        return true;
    }

    // Get remote env (flat field or nested config)
    const remoteEnv = remoteServer.env || remoteServer.config?.env;
    const remoteHasEnv = remoteServer.hasEnv === true;
    const localHasHiddenEnv =
      localServer.hasEnv === true &&
      (localServer.config as any)?.env === undefined;
    if (!remoteHasEnv || !localHasHiddenEnv) {
      if (
        JSON.stringify((localServer.config as any)?.env) !==
        JSON.stringify(remoteEnv)
      )
        return true;
    }

    if (
      Boolean(localServer.hasClientSecret) !==
      Boolean(remoteServer.hasClientSecret)
    )
      return true;
    if (Boolean(localServer.hasEnv) !== Boolean(remoteServer.hasEnv))
      return true;
    if (Boolean(localServer.hasHeaders) !== Boolean(remoteServer.hasHeaders))
      return true;

    // Check OAuth profile (handle both flat and nested structures)
    // For flat structure, convert oauthScopes array to comma-separated string for comparison
    const remoteOAuthProfile =
      remoteServer.oauthScopes ||
      remoteServer.clientId ||
      remoteServer.hasClientSecret ||
      remoteServer.oauthResourceUrl
        ? {
            ...(remoteServer.oauthFlowProfile ?? {}),
            scopes: Array.isArray(remoteServer.oauthScopes)
              ? remoteServer.oauthScopes.join(",")
              : remoteServer.oauthScopes,
            clientId: remoteServer.clientId,
            clientSecret:
              remoteServer.hasClientSecret === true
                ? ""
                : remoteServer.oauthFlowProfile?.clientSecret,
            resourceUrl:
              remoteServer.oauthResourceUrl ??
              remoteServer.oauthFlowProfile?.resourceUrl,
          }
        : remoteServer.oauthFlowProfile;
    if (
      JSON.stringify(localServer.oauthFlowProfile) !==
      JSON.stringify(remoteOAuthProfile)
    )
      return true;
  }

  return false;
}
