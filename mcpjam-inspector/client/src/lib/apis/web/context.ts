import { HOSTED_MODE } from "@/lib/config";

type GetAccessTokenFn = () => Promise<string | undefined | null>;

export interface HostedApiContext {
  workspaceId: string | null;
  serverIdsByName: Record<string, string>;
  getAccessToken?: GetAccessTokenFn;
  oauthTokensByServerId?: Record<string, string>;
  shareToken?: string;
}

type HostedAccessScope = "workspace_member" | "chat_v2";

const EMPTY_CONTEXT: HostedApiContext = {
  workspaceId: null,
  serverIdsByName: {},
};

let hostedApiContext: HostedApiContext = EMPTY_CONTEXT;

/**
 * Holds server-name → server-ID mappings injected by injectHostedServerMapping()
 * that have not yet appeared in the subscription data passed to setHostedApiContext().
 * This map survives setHostedApiContext() calls, ensuring the race between
 * a Convex mutation completing and the subscription propagating can't lose mappings.
 */
const pendingInjections = new Map<string, string>();

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
  const base = next ?? EMPTY_CONTEXT;

  // Self-clean: remove pending injections that the subscription now confirms.
  // Safe: Map spec allows delete of the current entry during for..of iteration.
  for (const [name, id] of pendingInjections) {
    if (base.serverIdsByName[name] === id) {
      pendingInjections.delete(name);
    }
  }

  // Merge any remaining pending injections so they survive stale subscription
  // updates that haven't caught up to the Convex mutation yet.
  if (pendingInjections.size > 0) {
    hostedApiContext = {
      ...base,
      serverIdsByName: {
        ...base.serverIdsByName,
        ...Object.fromEntries(pendingInjections),
      },
    };
  } else {
    hostedApiContext = base;
  }

  resetTokenCache();
}

/**
 * Eagerly inject a server-name → server-ID mapping into the hosted context,
 * bridging the gap between when a Convex mutation completes and when the
 * reactive subscription propagates the update through React.
 *
 * The mapping is stored in `pendingInjections` so it survives any
 * `setHostedApiContext()` calls that arrive with stale subscription data.
 * Once the subscription confirms the mapping, it is auto-removed.
 */
export function injectHostedServerMapping(
  serverName: string,
  serverId: string,
): void {
  if (!HOSTED_MODE) return;

  pendingInjections.set(serverName, serverId);

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

export function getHostedShareToken(): string | undefined {
  return hostedApiContext.shareToken;
}

function getHostedAccessScope(): HostedAccessScope | undefined {
  return getHostedShareToken() ? "chat_v2" : undefined;
}

export function buildHostedServerRequest(serverNameOrId: string): {
  workspaceId: string;
  serverId: string;
  oauthAccessToken?: string;
  accessScope?: HostedAccessScope;
  shareToken?: string;
} {
  const serverId = resolveHostedServerId(serverNameOrId);
  const oauthToken = getHostedOAuthToken(serverId);
  const shareToken = getHostedShareToken();
  const accessScope = getHostedAccessScope();
  return {
    workspaceId: getHostedWorkspaceId(),
    serverId,
    ...(oauthToken ? { oauthAccessToken: oauthToken } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(shareToken ? { shareToken } : {}),
  };
}

export function buildHostedServerBatchRequest(serverNamesOrIds: string[]): {
  workspaceId: string;
  serverIds: string[];
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  shareToken?: string;
} {
  const serverIds = resolveHostedServerIds(serverNamesOrIds);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  const shareToken = getHostedShareToken();
  const accessScope = getHostedAccessScope();
  return {
    workspaceId: getHostedWorkspaceId(),
    serverIds,
    ...(oauthTokens ? { oauthTokens } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(shareToken ? { shareToken } : {}),
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

/** @internal Exposed for testing only. */
export function _clearPendingInjections(): void {
  pendingInjections.clear();
}
