import type { ServerWithName } from "@/state/app-types";
import type { RemoteServer } from "@/hooks/useWorkspaces";

export interface PersistedServerPayload {
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  useOAuth?: boolean;
  oauthScopes?: string[];
  clientId?: string;
}

function stripAuthorizationHeader(
  headers: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      continue;
    }

    sanitized[key] = String(value);
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeScopes(scopes: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(scopes)) {
    return scopes.length > 0 ? [...scopes] : undefined;
  }

  if (typeof scopes === "string") {
    const parsed = scopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    return parsed.length > 0 ? parsed : undefined;
  }

  return undefined;
}

export function buildPersistedServerPayload(
  serverName: string,
  serverEntry: Pick<
    ServerWithName,
    "config" | "enabled" | "useOAuth" | "oauthFlowProfile"
  >,
): PersistedServerPayload {
  const config = serverEntry.config as Record<string, unknown>;
  const transportType = config.command ? "stdio" : "http";
  const rawUrl = config.url as string | URL | undefined;
  const rawRequestInit = config.requestInit as
    | { headers?: Record<string, unknown> }
    | undefined;
  const oauthScopes = normalizeScopes(serverEntry.oauthFlowProfile?.scopes);

  return {
    name: serverName,
    enabled: serverEntry.enabled ?? false,
    transportType,
    command: typeof config.command === "string" ? config.command : undefined,
    args: Array.isArray(config.args)
      ? (config.args as string[])
      : undefined,
    url:
      rawUrl instanceof URL
        ? rawUrl.href
        : typeof rawUrl === "string"
          ? rawUrl
          : undefined,
    headers: stripAuthorizationHeader(rawRequestInit?.headers),
    timeout: typeof config.timeout === "number" ? config.timeout : undefined,
    useOAuth: serverEntry.useOAuth,
    oauthScopes,
    clientId: serverEntry.oauthFlowProfile?.clientId || undefined,
  };
}

export function buildCarryForwardServerPayload(
  serverName: string,
  serverEntry: Pick<
    ServerWithName,
    "config" | "enabled" | "useOAuth" | "oauthFlowProfile"
  >,
): PersistedServerPayload {
  const payload = buildPersistedServerPayload(serverName, serverEntry);

  // Guest headers are intentionally dropped so guest-only secrets are not
  // uploaded into workspace data during guest -> signed-in carry-forward.
  return { ...payload, headers: undefined };
}

export function buildPersistedPayloadFromRemoteServer(
  remoteServer: Pick<
    RemoteServer,
    | "name"
    | "enabled"
    | "transportType"
    | "command"
    | "args"
    | "url"
    | "headers"
    | "timeout"
    | "useOAuth"
    | "oauthScopes"
    | "clientId"
  >,
): PersistedServerPayload {
  return {
    name: remoteServer.name,
    enabled: remoteServer.enabled,
    transportType: remoteServer.transportType,
    command: remoteServer.command,
    args: remoteServer.args ? [...remoteServer.args] : undefined,
    url: remoteServer.url,
    headers: stripAuthorizationHeader(remoteServer.headers),
    timeout: remoteServer.timeout,
    useOAuth: remoteServer.useOAuth,
    oauthScopes: normalizeScopes(remoteServer.oauthScopes),
    clientId: remoteServer.clientId,
  };
}

export interface CarryForwardComparableServer {
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  useOAuth?: boolean;
  oauthScopes?: string[] | string;
  clientId?: string;
}

export function buildPersistedPayloadFromCarryForwardComparableServer(
  remoteServer: CarryForwardComparableServer,
): PersistedServerPayload {
  return {
    name: remoteServer.name,
    enabled: remoteServer.enabled,
    transportType: remoteServer.transportType,
    command: remoteServer.command,
    args: remoteServer.args ? [...remoteServer.args] : undefined,
    url: remoteServer.url,
    headers: stripAuthorizationHeader(remoteServer.headers),
    timeout: remoteServer.timeout,
    useOAuth: remoteServer.useOAuth,
    oauthScopes: normalizeScopes(remoteServer.oauthScopes),
    clientId: remoteServer.clientId,
  };
}

function normalizePayload(
  payload: PersistedServerPayload,
): PersistedServerPayload {
  return {
    ...payload,
    args: payload.args ? [...payload.args] : undefined,
    headers: payload.headers
      ? Object.fromEntries(
          Object.entries(payload.headers).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : undefined,
    oauthScopes: payload.oauthScopes ? [...payload.oauthScopes] : undefined,
  };
}

export function persistedServerPayloadsEqual(
  left: PersistedServerPayload,
  right: PersistedServerPayload,
): boolean {
  return (
    JSON.stringify(normalizePayload(left)) ===
    JSON.stringify(normalizePayload(right))
  );
}

export function isCarryForwardRemoteServerEquivalent(
  localServer: Pick<
    ServerWithName,
    "config" | "enabled" | "useOAuth" | "oauthFlowProfile"
  >,
  remoteServer: CarryForwardComparableServer,
): boolean {
  const localPayload = buildPersistedServerPayload(remoteServer.name, localServer);
  const remotePayload =
    buildPersistedPayloadFromCarryForwardComparableServer(remoteServer);

  return persistedServerPayloadsEqual(
    { ...localPayload, headers: undefined },
    { ...remotePayload, headers: undefined },
  );
}

export function buildRemoteServerFromPersistedPayload(args: {
  payload: PersistedServerPayload;
  workspaceId: string;
  serverId?: string;
  createdAt?: number;
  updatedAt?: number;
}): RemoteServer {
  const now = Date.now();

  return {
    _id: args.serverId ?? `persisted:${args.payload.name}`,
    workspaceId: args.workspaceId,
    name: args.payload.name,
    enabled: args.payload.enabled,
    transportType: args.payload.transportType,
    command: args.payload.command,
    args: args.payload.args ? [...args.payload.args] : undefined,
    url: args.payload.url,
    headers: args.payload.headers
      ? { ...args.payload.headers }
      : undefined,
    timeout: args.payload.timeout,
    useOAuth: args.payload.useOAuth,
    oauthScopes: args.payload.oauthScopes
      ? [...args.payload.oauthScopes]
      : undefined,
    clientId: args.payload.clientId,
    createdAt: args.createdAt ?? now,
    updatedAt: args.updatedAt ?? now,
  };
}
