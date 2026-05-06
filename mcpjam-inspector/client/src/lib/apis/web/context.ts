import { HOSTED_MODE } from "@/lib/config";
import { getGuestBearerToken } from "@/lib/guest-session";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
import { BootstrapNotReadyError } from "@/lib/app-ready";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";

type GetAccessTokenFn = () => Promise<string | undefined | null>;

export interface HostedApiContext {
  projectId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  clientConfigSyncPending?: boolean;
  getAccessToken?: GetAccessTokenFn;
  oauthTokensByServerId?: Record<string, string>;
  shareToken?: string;
  chatboxToken?: string;
  isAuthenticated?: boolean;
  /** True when a WorkOS session exists (user signed in), even if token hasn't resolved yet. */
  hasSession?: boolean;
}

// chat_v2 scope is required for all non-guest API requests that write to chat history.
type HostedAccessScope = "project_member" | "chat_v2";

const EMPTY_CONTEXT: HostedApiContext = {
  projectId: null,
  serverIdsByName: {},
};

let hostedApiContext: HostedApiContext = EMPTY_CONTEXT;
let cachedBearerToken: { token: string; expiresAt: number } | null = null;

const TOKEN_CACHE_TTL_MS = 30_000;

export function resetTokenCache() {
  cachedBearerToken = null;
}

function assertHostedMode() {
  if (!HOSTED_MODE) {
    throw new Error("Hosted API context is only available in hosted mode");
  }
}

function assertHostedClientConfigSynced() {
  if (!hostedApiContext.clientConfigSyncPending) {
    return;
  }

  throw new Error(CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE);
}

export function shouldRetryHostedAuth401(): boolean {
  // Retry the auth bootstrap on 401 whenever the actor isn't yet authenticated
  // and no session is in flight — applies to both hosted guests and local CLI
  // users post unification.
  return !hostedApiContext.isAuthenticated && !hostedApiContext.hasSession;
}

/**
 * Hosted guest access uses the same Convex-backed project/server request shape
 * as signed-in users. Unauthenticated hosted actors still authenticate with the
 * guest JWT; they no longer send direct serverUrl request bodies.
 *
 * The gate is `!isAuthenticated && !hasSession`. The previous design treated a
 * set `projectId` as proof of an authenticated session; that assumption no
 * longer holds because guests can own projects. `hasSession` protects the
 * WorkOS bootstrap window from reusing a stale guest bearer while a signed-in
 * session is still resolving.
 */
function hasHostedGuestAccess(): boolean {
  // Now applies to both hosted and local: any actor without a WorkOS session
  // gets guest access. The local CLI mints its own guest bearer via the same
  // /api/web/guest-session endpoint hosted uses.
  if (hostedApiContext.isAuthenticated) return false;
  if (hostedApiContext.hasSession) return false;
  return true;
}

function shouldPreferGuestBearer(): boolean {
  return hasHostedGuestAccess();
}

export function setHostedApiContext(next: HostedApiContext | null): void {
  hostedApiContext = next
    ? {
        ...next,
        clientCapabilities:
          next.clientCapabilities ??
          (getDefaultClientCapabilities() as Record<string, unknown>),
      }
    : EMPTY_CONTEXT;
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

export function getHostedProjectId(): string {
  assertHostedMode();

  const projectId = hostedApiContext.projectId;
  if (!projectId) {
    throw new BootstrapNotReadyError(
      "provisioning-project",
      "hosted projectId is not in the API context yet",
    );
  }

  return projectId;
}

/**
 * Mode-agnostic project + server resolution used by code paths that need to
 * opt into the new `{projectId, serverId}` shape when context is populated,
 * but fall back to legacy when it isn't (e.g., during the post-migration
 * window or when a brand-new server hasn't been pushed to Convex yet).
 *
 * Returns null when either projectId is missing or the server name doesn't
 * resolve to a Convex Id. Callers handle null by using the legacy shape.
 */
export function tryResolveProjectServer(
  serverNameOrId: string,
): { projectId: string; serverId: string } | null {
  const projectId = hostedApiContext.projectId;
  if (!projectId) return null;
  const direct = hostedApiContext.serverIdsByName[serverNameOrId];
  if (direct) return { projectId, serverId: direct };
  if (
    Object.values(hostedApiContext.serverIdsByName).includes(serverNameOrId)
  ) {
    return { projectId, serverId: serverNameOrId };
  }
  return null;
}

/**
 * Long alphanumeric refs are usually Convex/legacy document ids. Never echo
 * them in user-visible error strings; short names and slugs may still be shown.
 */
function shouldIncludeHostedRefInNotFoundError(serverNameOrId: string): boolean {
  const t = serverNameOrId.trim();
  if (t.length < 1) {
    return false;
  }
  if (t.length >= 20 && /^[a-z0-9]+$/i.test(t)) {
    return false;
  }
  return true;
}

const HOSTED_SERVER_NOT_FOUND_OPAQUE_MESSAGE =
  "Hosted server not found. The server is not in your hosted project, or the server list is still loading.";

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

  if (shouldIncludeHostedRefInNotFoundError(serverNameOrId)) {
    throw new Error(`Hosted server not found for \"${serverNameOrId}\"`);
  }
  throw new Error(HOSTED_SERVER_NOT_FOUND_OPAQUE_MESSAGE);
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

function findHostedServerName(serverId: string): string | undefined {
  return Object.entries(hostedApiContext.serverIdsByName).find(
    ([, mappedId]) => mappedId === serverId,
  )?.[0];
}

/**
 * Resolves a hosted server display name or Convex server document ID to a
 * user-facing label when the server still exists in the current
 * `serverIdsByName` mapping. Returns undefined when the ref cannot be resolved
 * (for example, the server was removed from the project).
 */
export function tryGetHostedServerDisplayName(
  serverNameOrId: string,
): string | undefined {
  if (!HOSTED_MODE) {
    return undefined;
  }

  const trimmed = serverNameOrId.trim();
  if (!trimmed) {
    return undefined;
  }

  if (hostedApiContext.serverIdsByName[trimmed] !== undefined) {
    return trimmed;
  }

  return findHostedServerName(trimmed);
}

export function normalizeHostedServerNames(
  serverNamesOrIds: string[],
): string[] {
  assertHostedMode();

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const serverNameOrId of serverNamesOrIds) {
    if (typeof serverNameOrId !== "string") {
      continue;
    }

    const trimmed = serverNameOrId.trim();
    if (!trimmed) {
      continue;
    }

    const serverName =
      hostedApiContext.serverIdsByName[trimmed] !== undefined
        ? trimmed
        : (findHostedServerName(trimmed) ?? trimmed);
    const dedupeKey = serverName.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push(serverName);
  }

  return normalized;
}

function resolveHostedServerEntries(
  serverNamesOrIds: string[],
): Array<{ serverId: string; serverName: string }> {
  const seen = new Set<string>();
  const resolved: Array<{ serverId: string; serverName: string }> = [];

  for (const serverNameOrId of serverNamesOrIds) {
    const serverId = resolveHostedServerId(serverNameOrId);
    if (seen.has(serverId)) continue;
    seen.add(serverId);

    resolved.push({
      serverId,
      serverName:
        hostedApiContext.serverIdsByName[serverNameOrId] !== undefined
          ? serverNameOrId
          : (findHostedServerName(serverId) ?? serverNameOrId),
    });
  }

  return resolved;
}

export function getHostedOAuthToken(serverId: string): string | undefined {
  return hostedApiContext.oauthTokensByServerId?.[serverId];
}

export function getHostedShareToken(): string | undefined {
  return hostedApiContext.shareToken;
}

export function getHostedChatboxToken(): string | undefined {
  return hostedApiContext.chatboxToken;
}

function getHostedAccessScope(): HostedAccessScope | undefined {
  return getHostedShareToken() || getHostedChatboxToken()
    ? "chat_v2"
    : undefined;
}

export function buildHostedServerRequest(
  serverNameOrId: string,
): Record<string, unknown> {
  // Single hosted path: every request — guest or authed — carries
  // {projectId, serverId}. UI surfaces gate on `useAppReady()` so this
  // builder is never invoked before bootstrap completes; if it is invoked
  // early, `getHostedProjectId()` throws BootstrapNotReadyError instead
  // of emitting a guest-shape body that the server-side projectServerSchema
  // would reject with a confusing Zod 400.
  assertHostedClientConfigSynced();
  // Project id is checked FIRST so a not-yet-bootstrapped caller gets the
  // typed BootstrapNotReadyError, not a "Hosted server not found" — which
  // would just confuse the user about what's actually missing.
  const projectId = getHostedProjectId();
  const serverId = resolveHostedServerId(serverNameOrId);
  const oauthToken = getHostedOAuthToken(serverId);
  const shareToken = getHostedShareToken();
  const chatboxToken = getHostedChatboxToken();
  const accessScope = getHostedAccessScope();
  return {
    projectId,
    serverId,
    serverName:
      hostedApiContext.serverIdsByName[serverNameOrId] !== undefined
        ? serverNameOrId
        : (findHostedServerName(serverId) ?? serverNameOrId),
    ...(oauthToken ? { oauthAccessToken: oauthToken } : {}),
    ...(hostedApiContext.clientCapabilities
      ? { clientCapabilities: hostedApiContext.clientCapabilities }
      : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(shareToken ? { shareToken } : {}),
    ...(chatboxToken ? { chatboxToken } : {}),
  };
}

export function buildHostedServerBatchRequest(serverNamesOrIds: string[]): {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  clientCapabilities?: Record<string, unknown>;
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  shareToken?: string;
  chatboxToken?: string;
} {
  assertHostedClientConfigSynced();
  const projectId = getHostedProjectId();
  const serverEntries = resolveHostedServerEntries(serverNamesOrIds);
  const serverIds = serverEntries.map((entry) => entry.serverId);
  const serverNames = serverEntries.map((entry) => entry.serverName);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  const shareToken = getHostedShareToken();
  const chatboxToken = getHostedChatboxToken();
  const accessScope = getHostedAccessScope();
  return {
    projectId,
    serverIds,
    serverNames,
    ...(hostedApiContext.clientCapabilities
      ? { clientCapabilities: hostedApiContext.clientCapabilities }
      : {}),
    ...(oauthTokens ? { oauthTokens } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(shareToken ? { shareToken } : {}),
    ...(chatboxToken ? { chatboxToken } : {}),
  };
}

export function buildHostedEvalServerBatchRequest(serverNamesOrIds: string[]): {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  clientCapabilities?: Record<string, unknown>;
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  shareToken?: string;
  chatboxToken?: string;
} {
  assertHostedClientConfigSynced();
  const projectId = getHostedProjectId();
  const serverEntries = resolveHostedServerEntries(serverNamesOrIds);
  const serverIds = serverEntries.map((entry) => entry.serverId);
  const serverNames = serverEntries.map((entry) => entry.serverName);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  const shareToken = getHostedShareToken();
  const chatboxToken = getHostedChatboxToken();
  const accessScope = getHostedAccessScope();

  return {
    projectId,
    serverIds,
    serverNames,
    ...(hostedApiContext.clientCapabilities
      ? { clientCapabilities: hostedApiContext.clientCapabilities }
      : {}),
    ...(oauthTokens ? { oauthTokens } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(shareToken ? { shareToken } : {}),
    ...(chatboxToken ? { chatboxToken } : {}),
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
  // Single bearer-resolution path for hosted and local. authFetch decides
  // whether to attach the result based on the request's loopback/origin and
  // whether a token is available; this function never short-circuits on mode.
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
