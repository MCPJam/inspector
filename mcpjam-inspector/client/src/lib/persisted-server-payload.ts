import type { ServerWithName } from "@/state/app-types";

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

function normalizeHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = String(value);
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
    headers: normalizeHeaders(rawRequestInit?.headers),
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
