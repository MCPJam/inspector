import { HOSTED_MODE } from "@/lib/config";
import { getGuestBearerToken } from "@/lib/guest-session";

type GetAccessTokenFn = () => Promise<string | undefined | null>;

export interface HostedApiContext {
  workspaceId: string | null;
  serverIdsByName: Record<string, string>;
  getAccessToken?: GetAccessTokenFn;
  oauthTokensByServerId?: Record<string, string>;
  guestOauthTokensByServerName?: Record<string, string>;
  shareToken?: string;
  isAuthenticated?: boolean;
  /** True when a WorkOS session exists (user signed in), even if token hasn't resolved yet. */
  hasSession?: boolean;
  /** Maps server name → MCPServerConfig for guest mode (no Convex). */
  serverConfigs?: Record<string, unknown>;
}

type HostedAccessScope = "workspace_member" | "chat_v2";

const EMPTY_CONTEXT: HostedApiContext = {
  workspaceId: null,
  serverIdsByName: {},
};

let hostedApiContext: HostedApiContext = EMPTY_CONTEXT;
let cachedBearerToken: { token: string; expiresAt: number } | null = null;

const TOKEN_CACHE_TTL_MS = 30_000;

export function resetTokenCache() {
  cachedBearerToken = null;
}

function readStoredGuestOAuthAccessToken(
  serverName: string,
): string | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    const raw = localStorage.getItem(`mcp-tokens-${serverName}`);
    if (!raw) return undefined;

    const parsed = JSON.parse(raw) as { access_token?: unknown };
    if (
      typeof parsed.access_token === "string" &&
      parsed.access_token.trim().length > 0
    ) {
      return parsed.access_token;
    }
  } catch {
    // Ignore malformed localStorage data and fall back to in-memory context.
  }

  return undefined;
}

function assertHostedMode() {
  if (!HOSTED_MODE) {
    throw new Error("Hosted API context is only available in hosted mode");
  }
}

/**
 * True when running in hosted mode as a direct guest connection.
 * Direct guests store server configs in localStorage and connect directly
 * without Convex authorization.
 */
export function isGuestMode(): boolean {
  if (!HOSTED_MODE) return false;
  return !hostedApiContext.workspaceId && !hostedApiContext.isAuthenticated;
}

export function shouldRetryHostedAuth401(): boolean {
  if (!HOSTED_MODE) return false;
  return !hostedApiContext.isAuthenticated;
}

/**
 * Hosted guest access comes in 2 shapes:
 * - direct guest: no workspace, direct serverUrl requests
 * - shared guest: workspace-scoped share token, Convex-backed requests
 */
function hasHostedGuestAccess(): boolean {
  if (!HOSTED_MODE) return false;
  if (hostedApiContext.isAuthenticated) return false;
  return !hostedApiContext.workspaceId || !!hostedApiContext.shareToken;
}

/**
 * Prefer the guest bearer for both direct guests and shared guests.
 * Shared guests still use Convex-backed requests; they only differ in how the
 * bearer is obtained.
 */
function shouldPreferGuestBearer(): boolean {
  return hasHostedGuestAccess();
}

export function buildGuestServerRequest(
  config: unknown,
  oauthAccessToken?: string,
): Record<string, unknown> {
  const httpConfig = config as {
    url?: string | URL;
    requestInit?: { headers?: Record<string, string> };
  };
  if (!httpConfig.url) {
    throw new Error("Guest server config must have a URL");
  }
  const urlStr =
    typeof httpConfig.url === "string"
      ? httpConfig.url
      : httpConfig.url.toString();
  const headers = httpConfig.requestInit?.headers;
  return {
    serverUrl: urlStr,
    ...(headers && Object.keys(headers).length > 0
      ? { serverHeaders: headers }
      : {}),
    ...(oauthAccessToken ? { oauthAccessToken } : {}),
  };
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

export function getHostedShareToken(): string | undefined {
  return hostedApiContext.shareToken;
}

function getHostedAccessScope(): HostedAccessScope | undefined {
  return getHostedShareToken() ? "chat_v2" : undefined;
}

export function buildHostedServerRequest(
  serverNameOrId: string,
): Record<string, unknown> {
  // Guest path: use directly-provided server config (no Convex)
  if (isGuestMode()) {
    const config = hostedApiContext.serverConfigs?.[serverNameOrId];
    if (!config) {
      throw new Error(
        `No guest server config found for "${serverNameOrId}". ` +
          "The server may not be loaded yet.",
      );
    }
    // Prefer persisted OAuth tokens so guest requests can keep working even if
    // React state has not yet synchronized token updates.
    const oauthToken =
      readStoredGuestOAuthAccessToken(serverNameOrId) ??
      hostedApiContext.guestOauthTokensByServerName?.[serverNameOrId];

    return buildGuestServerRequest(config, oauthToken);
  }

  // Authenticated path: resolve via Convex server mappings
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

  // In guest mode, bypass WorkOS token bootstrap entirely and use a guest
  // bearer token directly. This avoids stale/invalid WorkOS tokens from
  // masking valid guest sessions.
  if (shouldPreferGuestBearer()) {
    const guestToken = await getGuestBearerToken();
    if (guestToken) {
      cachedBearerToken = {
        token: guestToken,
        expiresAt: now + TOKEN_CACHE_TTL_MS,
      };
      return `Bearer ${guestToken}`;
    }
  }

  // Try WorkOS (logged-in user)
  const getAccessToken = hostedApiContext.getAccessToken;
  if (getAccessToken) {
    try {
      const token = await getAccessToken();
      if (token) {
        cachedBearerToken = { token, expiresAt: now + TOKEN_CACHE_TTL_MS };
        return `Bearer ${token}`;
      }
    } catch {
      // WorkOS LoginRequiredError — not authenticated, fall through to guest
    }
  }

  if (!hasHostedGuestAccess()) {
    return null;
  }

  // Fall back to guest token for explicit guest-capable surfaces only.
  const guestToken = await getGuestBearerToken();
  if (guestToken) {
    cachedBearerToken = {
      token: guestToken,
      expiresAt: now + TOKEN_CACHE_TTL_MS,
    };
    return `Bearer ${guestToken}`;
  }

  return null;
}
