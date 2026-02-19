import { HOSTED_MODE } from "@/lib/config";

type GetAccessTokenFn = () => Promise<string | undefined | null>;

export interface HostedApiContext {
  workspaceId: string | null;
  serverIdsByName: Record<string, string>;
  getAccessToken?: GetAccessTokenFn;
  oauthTokensByServerId?: Record<string, string>;
}

const EMPTY_CONTEXT: HostedApiContext = {
  workspaceId: null,
  serverIdsByName: {},
};

let hostedApiContext: HostedApiContext = EMPTY_CONTEXT;
let cachedBearerToken: { token: string; expiresAt: number } | null = null;

const TOKEN_CACHE_TTL_MS = 30_000;

function resetTokenCache() {
  cachedBearerToken = null;
}

function assertHostedMode() {
  if (!HOSTED_MODE) {
    throw new Error("Hosted API context is only available in hosted mode");
  }
}

export function setHostedApiContext(next: HostedApiContext | null): void {
  hostedApiContext = next ?? EMPTY_CONTEXT;
  resetTokenCache();
}

/**
 * Eagerly inject a server-name → server-ID mapping into the hosted context,
 * bridging the gap between when a Convex mutation completes and when the
 * reactive subscription propagates the update through React.
 *
 * The next `setHostedApiContext` call from the subscription will overwrite
 * this with identical data, so there is no risk of stale entries.
 */
export function injectHostedServerMapping(
  serverName: string,
  serverId: string,
): void {
  if (!HOSTED_MODE) return;
  hostedApiContext = {
    ...hostedApiContext,
    serverIdsByName: {
      ...hostedApiContext.serverIdsByName,
      [serverName]: serverId,
    },
  };
}

export function getHostedWorkspaceId(): string {
  assertHostedMode();

  const workspaceId = hostedApiContext.workspaceId;
  if (!workspaceId) {
    throw new Error("Hosted workspace is not available yet");
  }

  return workspaceId;
}

export function resolveHostedServerId(serverNameOrId: string): string {
  assertHostedMode();

  const mapped = hostedApiContext.serverIdsByName[serverNameOrId];
  if (mapped) return mapped;

  // Allow direct server IDs for callers that already resolved names.
  if (
    Object.values(hostedApiContext.serverIdsByName).includes(serverNameOrId)
  ) {
    return serverNameOrId;
  }

  throw new Error(`Hosted server not found for \"${serverNameOrId}\"`);
}

export function resolveHostedServerIds(serverNamesOrIds: string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const serverNameOrId of serverNamesOrIds) {
    const nextId = resolveHostedServerId(serverNameOrId);
    if (seen.has(nextId)) continue;
    seen.add(nextId);
    resolved.push(nextId);
  }

  return resolved;
}

export function getHostedOAuthToken(serverId: string): string | undefined {
  return hostedApiContext.oauthTokensByServerId?.[serverId];
}

export function buildHostedServerRequest(serverNameOrId: string): {
  workspaceId: string;
  serverId: string;
  oauthAccessToken?: string;
} {
  const serverId = resolveHostedServerId(serverNameOrId);
  const oauthToken = getHostedOAuthToken(serverId);
  return {
    workspaceId: getHostedWorkspaceId(),
    serverId,
    ...(oauthToken ? { oauthAccessToken: oauthToken } : {}),
  };
}

export function buildHostedServerBatchRequest(serverNamesOrIds: string[]): {
  workspaceId: string;
  serverIds: string[];
  oauthTokens?: Record<string, string>;
} {
  const serverIds = resolveHostedServerIds(serverNamesOrIds);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  return {
    workspaceId: getHostedWorkspaceId(),
    serverIds,
    ...(oauthTokens ? { oauthTokens } : {}),
  };
}

export function buildHostedOAuthTokensMap(
  serverIds: string[],
): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const id of serverIds) {
    const token = getHostedOAuthToken(id);
    if (token) map[id] = token;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export async function getHostedAuthorizationHeader(): Promise<string | null> {
  if (!HOSTED_MODE) return null;

  const now = Date.now();
  if (cachedBearerToken && cachedBearerToken.expiresAt > now) {
    return `Bearer ${cachedBearerToken.token}`;
  }

  const getAccessToken = hostedApiContext.getAccessToken;
  if (!getAccessToken) return null;

  const token = await getAccessToken();
  if (!token) {
    cachedBearerToken = null;
    return null;
  }

  cachedBearerToken = {
    token,
    expiresAt: now + TOKEN_CACHE_TTL_MS,
  };

  return `Bearer ${token}`;
}
