import { HOSTED_MODE } from "@/lib/config";
import { getGuestBearerToken } from "@/lib/guest-session";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
import { BootstrapNotReadyError } from "@/lib/app-ready";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";

type GetAccessTokenFn = () => Promise<string | undefined | null>;

export interface ApiContext {
  projectId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  clientConfigSyncPending?: boolean;
  getAccessToken?: GetAccessTokenFn;
  oauthTokensByServerId?: Record<string, string>;
  /**
   * Resolved chatbox identity. After /api/web/chatboxes/redeem resolves,
   * the host clones these onto every chatbox-aware API call. The URL link
   * token is consumed only at redemption time and never threaded onto the
   * read path.
   */
  chatboxId?: string;
  accessVersion?: number;
  isAuthenticated?: boolean;
  /** True when a WorkOS session exists (user signed in), even if token hasn't resolved yet. */
  hasSession?: boolean;
}

// chat_v2 scope is required for all non-guest API requests that write to chat history.
type HostedAccessScope = "project_member" | "chat_v2";

const EMPTY_CONTEXT: ApiContext = {
  projectId: null,
  serverIdsByName: {},
};

let apiContext: ApiContext = EMPTY_CONTEXT;
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

function assertClientConfigSynced() {
  if (!apiContext.clientConfigSyncPending) {
    return;
  }

  throw new Error(CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE);
}

export function shouldRetryApiAuth401(): boolean {
  // Retry the auth bootstrap on 401 whenever the actor isn't yet authenticated
  // and no session is in flight — applies to both hosted guests and local CLI
  // users post unification.
  return !apiContext.isAuthenticated && !apiContext.hasSession;
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
  if (apiContext.isAuthenticated) return false;
  if (apiContext.hasSession) return false;
  return true;
}

function shouldPreferGuestBearer(): boolean {
  return hasHostedGuestAccess();
}

export function setApiContext(next: ApiContext | null): void {
  apiContext = next
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
 * Eagerly inject a server-name → server-ID mapping into the API context,
 * bridging the gap between when a Convex mutation completes and when the
 * reactive subscription propagates the update through React.
 *
 * Applies to both hosted and local: post unification, local mode also drives
 * connect/reconnect through the resolver path when a Convex serverId is known,
 * so it benefits from the same eager injection. Without this, the immediate
 * post-save connect would fall back to the legacy `{serverConfig, serverId}`
 * shape for one tick.
 *
 * The next `setApiContext` call from the subscription will overwrite
 * this with identical data, so there is no risk of stale entries.
 */
export function injectHostedServerMapping(
  serverName: string,
  serverId: string,
): void {
  apiContext = {
    ...apiContext,
    serverIdsByName: {
      ...apiContext.serverIdsByName,
      [serverName]: serverId,
    },
  };
}

export function getHostedProjectId(): string {
  assertHostedMode();

  const projectId = apiContext.projectId;
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
  const projectId = apiContext.projectId;
  if (!projectId) return null;
  const direct = apiContext.serverIdsByName[serverNameOrId];
  if (direct) return { projectId, serverId: direct };
  if (
    Object.values(apiContext.serverIdsByName).includes(serverNameOrId)
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

  const mapped = apiContext.serverIdsByName[serverNameOrId];
  if (mapped) return mapped;

  // Allow direct server IDs for callers that already resolved names.
  if (
    Object.values(apiContext.serverIdsByName).includes(serverNameOrId)
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
  return Object.entries(apiContext.serverIdsByName).find(
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

  if (apiContext.serverIdsByName[trimmed] !== undefined) {
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
      apiContext.serverIdsByName[trimmed] !== undefined
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
        apiContext.serverIdsByName[serverNameOrId] !== undefined
          ? serverNameOrId
          : (findHostedServerName(serverId) ?? serverNameOrId),
    });
  }

  return resolved;
}

export function getHostedOAuthToken(serverId: string): string | undefined {
  return apiContext.oauthTokensByServerId?.[serverId];
}

export function getHostedChatboxId(): string | undefined {
  return apiContext.chatboxId;
}

export function getHostedChatboxAccessVersion(): number | undefined {
  return apiContext.accessVersion;
}

function getHostedAccessScope(): HostedAccessScope | undefined {
  return getHostedChatboxId() ? "chat_v2" : undefined;
}

export function buildServerRequest(
  serverNameOrId: string,
): Record<string, unknown> {
  // Single hosted path: every request — guest or authed — carries
  // {projectId, serverId}. UI surfaces gate on `useAppReady()` so this
  // builder is never invoked before bootstrap completes; if it is invoked
  // early, `getHostedProjectId()` throws BootstrapNotReadyError instead
  // of emitting a guest-shape body that the server-side projectServerSchema
  // would reject with a confusing Zod 400.
  assertClientConfigSynced();
  // Project id is checked FIRST so a not-yet-bootstrapped caller gets the
  // typed BootstrapNotReadyError, not a "Hosted server not found" — which
  // would just confuse the user about what's actually missing.
  const projectId = getHostedProjectId();
  const serverId = resolveHostedServerId(serverNameOrId);
  const oauthToken = getHostedOAuthToken(serverId);
  const chatboxId = getHostedChatboxId();
  const accessVersion = getHostedChatboxAccessVersion();
  const accessScope = getHostedAccessScope();
  return {
    projectId,
    serverId,
    serverName:
      apiContext.serverIdsByName[serverNameOrId] !== undefined
        ? serverNameOrId
        : (findHostedServerName(serverId) ?? serverNameOrId),
    ...(oauthToken ? { oauthAccessToken: oauthToken } : {}),
    ...(apiContext.clientCapabilities
      ? { clientCapabilities: apiContext.clientCapabilities }
      : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(chatboxId ? { chatboxId } : {}),
    ...(chatboxId && Number.isFinite(accessVersion)
      ? { accessVersion }
      : {}),
  };
}

export function buildServerBatchRequest(serverNamesOrIds: string[]): {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  clientCapabilities?: Record<string, unknown>;
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  chatboxId?: string;
  accessVersion?: number;
} {
  assertClientConfigSynced();
  const projectId = getHostedProjectId();
  const serverEntries = resolveHostedServerEntries(serverNamesOrIds);
  const serverIds = serverEntries.map((entry) => entry.serverId);
  const serverNames = serverEntries.map((entry) => entry.serverName);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  const chatboxId = getHostedChatboxId();
  const accessVersion = getHostedChatboxAccessVersion();
  const accessScope = getHostedAccessScope();
  return {
    projectId,
    serverIds,
    serverNames,
    ...(apiContext.clientCapabilities
      ? { clientCapabilities: apiContext.clientCapabilities }
      : {}),
    ...(oauthTokens ? { oauthTokens } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(chatboxId ? { chatboxId } : {}),
    ...(chatboxId && Number.isFinite(accessVersion)
      ? { accessVersion }
      : {}),
  };
}

export function buildHostedEvalServerBatchRequest(serverNamesOrIds: string[]): {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  clientCapabilities?: Record<string, unknown>;
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  chatboxId?: string;
  accessVersion?: number;
} {
  assertClientConfigSynced();
  const projectId = getHostedProjectId();
  const serverEntries = resolveHostedServerEntries(serverNamesOrIds);
  const serverIds = serverEntries.map((entry) => entry.serverId);
  const serverNames = serverEntries.map((entry) => entry.serverName);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  const chatboxId = getHostedChatboxId();
  const accessVersion = getHostedChatboxAccessVersion();
  const accessScope = getHostedAccessScope();

  return {
    projectId,
    serverIds,
    serverNames,
    ...(apiContext.clientCapabilities
      ? { clientCapabilities: apiContext.clientCapabilities }
      : {}),
    ...(oauthTokens ? { oauthTokens } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(chatboxId ? { chatboxId } : {}),
    ...(chatboxId && Number.isFinite(accessVersion)
      ? { accessVersion }
      : {}),
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

export async function getApiAuthorizationHeader(): Promise<string | null> {
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
  const getAccessToken = apiContext.getAccessToken;
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
