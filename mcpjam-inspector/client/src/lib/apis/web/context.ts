import { HOSTED_MODE } from "@/lib/config";
import { getGuestBearerToken } from "@/lib/guest-session";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
import { BootstrapNotReadyError } from "@/lib/app-ready";
import {
  clearTrackedTasksForScope,
  setTrackedTaskScope,
} from "@/lib/task-tracker";
import {
  getDefaultClientCapabilities,
  type McpProtocolVersion,
  type XaaEnterprisePolicy,
} from "@mcpjam/sdk/browser";

type GetAccessTokenFn = () => Promise<string | undefined | null>;

export interface ApiContext {
  projectId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  /**
   * Resolved MCP profile pins. Single-server hosted routes forward these
   * fields so ephemeral managers use the same wire mode as connect/validate.
   */
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  /**
   * SEP-2243 `Mcp-Param-*` mirroring, resolved from the active host's
   * `mcpProfile.toolParamHeaderMirroring`. Only ever `false` (= the host asked
   * to simulate a client that does not mirror); `"mirror"` is the SDK's
   * no-field default.
   *
   * Host-level and therefore batch-uniform — unlike the protocol pin, there is
   * no per-server map. It rides EVERY hosted request body, not just
   * connect/validate: chat, eval, prompt and journey runs each build their own
   * ephemeral manager, so a knob that reached only the connect path would let
   * those runs quietly send the headers the host asked to suppress.
   */
  mirrorToolParamHeaders?: boolean;
  /**
   * Sibling client-conformance knobs from the active host's
   * `mcpProfile.paginationTraversal` / `mcpProfile.mrtrSupport`. Same
   * carry-everywhere hazard as the mirroring knob above: every ephemeral
   * manager (chat, eval, prompt, journey) must see them, or those runs
   * quietly execute as a fully conforming client. Only the non-default value
   * is ever set.
   */
  firstPageOnly?: true;
  supportsMrtr?: false;
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  suppressLegacyRequestCancellation?: true;
  suppressModernRequestCancellation?: true;
  /**
   * The active host's enterprise-managed authorization policy (validated
   * `on` value only). Rides ad-hoc chat/eval bodies; ignored server-side
   * whenever a backend host config exists (scenario/host-bound turns read
   * the policy server-authoritatively instead).
   */
  xaaPolicy?: XaaEnterprisePolicy;
  clientConfigSyncPending?: boolean;
  getAccessToken?: GetAccessTokenFn;
  oauthTokensByServerId?: Record<string, string>;
  /**
   * Resolved scenario identity. After /api/web/scenarios/redeem resolves,
   * the host clones these onto every scenario-aware API call. The URL link
   * token is consumed only at redemption time and never threaded onto the
   * read path.
   */
  scenarioId?: string;
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
let apiContextRevision = 0;
const apiContextListeners = new Set<() => void>();

const TOKEN_CACHE_TTL_MS = 30_000;

/**
 * How long a request may wait for a WorkOS access token that has not resolved
 * yet, and how often to re-ask for it.
 *
 * AuthKit answers `null` (or throws `LoginRequiredError`) while it is
 * bootstrapping or refreshing a session, and every `/api/web/*` route is gated
 * by `bearerAuthMiddleware`, so dispatching inside that window is a request
 * that cannot succeed. The budget is short enough that a genuinely expired
 * session still fails fast — the 401 it produces is classified as
 * `auth/missing_bearer` and reads as a sign-in problem — and long enough to
 * cover an ordinary token refresh.
 */
const SESSION_BEARER_WAIT_MS = 3_000;
const SESSION_BEARER_POLL_MS = 100;

/**
 * The single in-flight wait, shared by every caller that lands in the same
 * window. Three requests racing one bootstrap should poll once, not three
 * times.
 */
let pendingSessionBearer: Promise<string | null> | null = null;

export function resetTokenCache() {
  cachedBearerToken = null;
}

function notifyApiContextChanged() {
  apiContextRevision += 1;
  for (const listener of apiContextListeners) {
    listener();
  }
}

export function subscribeApiContext(listener: () => void): () => void {
  apiContextListeners.add(listener);
  return () => {
    apiContextListeners.delete(listener);
  };
}

export function getApiContextRevision(): number {
  return apiContextRevision;
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
  // Task handles are bearer-ish and scoped to the actor that created them:
  // rescope the tracker on every context change, and drop the previous
  // actor's handles when the project/org actually changes (logout, switch).
  //
  // Only an actual actor change clears them: `useApiContext` tears the context
  // down (`setApiContext(null)`) on every dependency change and remounts it
  // immediately, so treating "scope went away" as a logout would delete live
  // task handles on ordinary re-renders. A clear therefore requires a
  // different, DEFINED next scope.
  const previousProjectId = apiContext.projectId ?? undefined;
  const nextProjectId = next?.projectId ?? undefined;
  if (
    previousProjectId &&
    nextProjectId &&
    previousProjectId !== nextProjectId
  ) {
    clearTrackedTasksForScope(previousProjectId);
  }
  setTrackedTaskScope(nextProjectId);

  apiContext = next
    ? {
        ...next,
        clientCapabilities:
          next.clientCapabilities ??
          (getDefaultClientCapabilities() as Record<string, unknown>),
      }
    : EMPTY_CONTEXT;
  resetTokenCache();
  notifyApiContextChanged();
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
  serverId: string
): void {
  apiContext = {
    ...apiContext,
    serverIdsByName: {
      ...apiContext.serverIdsByName,
      [serverName]: serverId,
    },
  };
  notifyApiContextChanged();
}

export function getHostedProjectId(): string {
  // Context-gated, not mode-gated: local builds populate the same API
  // context (unified bootstrap, scenario runtime), and the null check below
  // is the real guard. Callers that are genuinely hosted-only stay behind
  // their own HOSTED_MODE forks.
  const projectId = apiContext.projectId;
  if (!projectId) {
    throw new BootstrapNotReadyError(
      "provisioning-project",
      "hosted projectId is not in the API context yet"
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
  serverNameOrId: string
): { projectId: string; serverId: string } | null {
  const projectId = apiContext.projectId;
  if (!projectId) return null;
  const direct = apiContext.serverIdsByName[serverNameOrId];
  if (direct) return { projectId, serverId: direct };
  if (Object.values(apiContext.serverIdsByName).includes(serverNameOrId)) {
    return { projectId, serverId: serverNameOrId };
  }
  return null;
}

/**
 * Long alphanumeric refs are usually Convex/legacy document ids. Never echo
 * them in user-visible error strings; short names and slugs may still be shown.
 */
function shouldIncludeHostedRefInNotFoundError(
  serverNameOrId: string
): boolean {
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
  // Context-gated, not mode-gated — see getHostedProjectId.
  const mapped = apiContext.serverIdsByName[serverNameOrId];
  if (mapped) return mapped;

  // Allow direct server IDs for callers that already resolved names.
  if (Object.values(apiContext.serverIdsByName).includes(serverNameOrId)) {
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
    ([, mappedId]) => mappedId === serverId
  )?.[0];
}

/**
 * Resolves a hosted server display name or Convex server document ID to a
 * user-facing label when the server still exists in the current
 * `serverIdsByName` mapping. Returns undefined when the ref cannot be resolved
 * (for example, the server was removed from the project).
 */
export function tryGetHostedServerDisplayName(
  serverNameOrId: string
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
  serverNamesOrIds: string[]
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
        : findHostedServerName(trimmed) ?? trimmed;
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
  serverNamesOrIds: string[]
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
          : findHostedServerName(serverId) ?? serverNameOrId,
    });
  }

  return resolved;
}

export function getHostedOAuthToken(serverId: string): string | undefined {
  return apiContext.oauthTokensByServerId?.[serverId];
}

export function getHostedScenarioId(): string | undefined {
  return apiContext.scenarioId;
}

export function getHostedScenarioAccessVersion(): number | undefined {
  return apiContext.accessVersion;
}

function getHostedAccessScope(): HostedAccessScope | undefined {
  return getHostedScenarioId() ? "chat_v2" : undefined;
}

/**
 * The client-conformance knobs, reduced to the wire fields the hosted routes
 * accept. ONE emitter for all four body builders: these fields are only ever
 * carried, never derived, and the failure mode of forgetting one is silent —
 * a host configured as a non-conforming client would execute as a conforming
 * one on whichever flow got missed. Declaring them on `ApiContext` is not
 * enough; they only reach the wire if they are spread into the body.
 *
 * Only the NON-default value is emitted, matching how the SDK reads them: an
 * absent field means the full behavior, so sending the default would put a
 * field on every request that never carried one.
 */
function conformanceWireFields(apiContext: ApiContext): {
  mirrorToolParamHeaders?: false;
  firstPageOnly?: true;
  supportsMrtr?: false;
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  suppressLegacyRequestCancellation?: true;
  suppressModernRequestCancellation?: true;
} {
  return {
    ...(apiContext.mirrorToolParamHeaders === false
      ? { mirrorToolParamHeaders: false as const }
      : {}),
    ...(apiContext.firstPageOnly === true
      ? { firstPageOnly: true as const }
      : {}),
    ...(apiContext.suppressListenChannel === true
      ? { suppressListenChannel: true as const }
      : {}),
    ...(apiContext.dropToolListChanged === true
      ? { dropToolListChanged: true as const }
      : {}),
    ...(apiContext.suppressLegacyRequestCancellation === true
      ? { suppressLegacyRequestCancellation: true as const }
      : {}),
    ...(apiContext.suppressModernRequestCancellation === true
      ? { suppressModernRequestCancellation: true as const }
      : {}),
    ...(apiContext.supportsMrtr === false
      ? { supportsMrtr: false as const }
      : {}),
  };
}

export function buildServerRequest(
  serverNameOrId: string
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
  const scenarioId = getHostedScenarioId();
  const accessVersion = getHostedScenarioAccessVersion();
  const accessScope = getHostedAccessScope();
  return {
    projectId,
    serverId,
    serverName:
      apiContext.serverIdsByName[serverNameOrId] !== undefined
        ? serverNameOrId
        : findHostedServerName(serverId) ?? serverNameOrId,
    ...(oauthToken ? { oauthAccessToken: oauthToken } : {}),
    ...(apiContext.clientCapabilities
      ? { clientCapabilities: apiContext.clientCapabilities }
      : {}),
    ...(apiContext.clientInfo ? { clientInfo: apiContext.clientInfo } : {}),
    ...(apiContext.supportedProtocolVersions?.length
      ? { supportedProtocolVersions: apiContext.supportedProtocolVersions }
      : {}),
    ...(apiContext.mcpProtocolVersionsByServerId?.[serverId]
      ? {
          mcpProtocolVersion:
            apiContext.mcpProtocolVersionsByServerId[serverId],
        }
      : {}),
    // Single-server flows (tools/resources/prompts, validate) enforce the
    // same host policy as batch connects — omitting it here would let these
    // ephemeral connections bypass enterprise-managed auth. Ignored
    // server-side for scenario-scoped calls (server-authoritative fetch wins).
    // Only `false` reaches the wire; see `ApiContext.mirrorToolParamHeaders`.
    ...conformanceWireFields(apiContext),
    ...(apiContext.xaaPolicy ? { xaaPolicy: apiContext.xaaPolicy } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(scenarioId && Number.isFinite(accessVersion) ? { accessVersion } : {}),
  };
}

export function buildServerBatchRequest(serverNamesOrIds: string[]): {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  mirrorToolParamHeaders?: boolean;
  firstPageOnly?: true;
  supportsMrtr?: false;
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  suppressLegacyRequestCancellation?: true;
  suppressModernRequestCancellation?: true;
  xaaPolicy?: XaaEnterprisePolicy;
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  scenarioId?: string;
  accessVersion?: number;
} {
  assertClientConfigSynced();
  const projectId = getHostedProjectId();
  const serverEntries = resolveHostedServerEntries(serverNamesOrIds);
  const serverIds = serverEntries.map((entry) => entry.serverId);
  const serverNames = serverEntries.map((entry) => entry.serverName);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  const protocolVersions = buildBatchProtocolVersionMap(serverIds);
  const scenarioId = getHostedScenarioId();
  const accessVersion = getHostedScenarioAccessVersion();
  const accessScope = getHostedAccessScope();
  return {
    projectId,
    serverIds,
    serverNames,
    ...(apiContext.clientCapabilities
      ? { clientCapabilities: apiContext.clientCapabilities }
      : {}),
    ...(apiContext.clientInfo ? { clientInfo: apiContext.clientInfo } : {}),
    ...(apiContext.supportedProtocolVersions?.length
      ? { supportedProtocolVersions: apiContext.supportedProtocolVersions }
      : {}),
    ...(protocolVersions
      ? { mcpProtocolVersionsByServerId: protocolVersions }
      : {}),
    // Only `false` reaches the wire; see `ApiContext.mirrorToolParamHeaders`.
    ...conformanceWireFields(apiContext),
    ...(apiContext.xaaPolicy ? { xaaPolicy: apiContext.xaaPolicy } : {}),
    ...(oauthTokens ? { oauthTokens } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(scenarioId && Number.isFinite(accessVersion) ? { accessVersion } : {}),
  };
}

/**
 * `App.tsx` validates host profile pins and per-server overrides before
 * populating `apiContext.mcpProtocolVersionsByServerId`, so this helper only
 * filters the already-resolved map down to the requested server ids.
 */
function buildBatchProtocolVersionMap(
  serverIds: string[]
): Record<string, McpProtocolVersion> | undefined {
  const source = apiContext.mcpProtocolVersionsByServerId;
  if (!source) return undefined;
  const filtered: Record<string, McpProtocolVersion> = {};
  for (const id of serverIds) {
    const pin = source[id];
    if (pin) filtered[id] = pin;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function buildResolvedServerBatchRequest(input: {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  scenarioId?: string;
  accessVersion?: number;
}): {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  mirrorToolParamHeaders?: boolean;
  firstPageOnly?: true;
  supportsMrtr?: false;
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  suppressLegacyRequestCancellation?: true;
  suppressModernRequestCancellation?: true;
  xaaPolicy?: XaaEnterprisePolicy;
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  scenarioId?: string;
  accessVersion?: number;
} {
  assertClientConfigSynced();
  const protocolVersions = buildBatchProtocolVersionMap(input.serverIds);
  return {
    projectId: input.projectId,
    serverIds: input.serverIds,
    serverNames: input.serverNames,
    ...(apiContext.clientCapabilities
      ? { clientCapabilities: apiContext.clientCapabilities }
      : {}),
    ...(apiContext.clientInfo ? { clientInfo: apiContext.clientInfo } : {}),
    ...(apiContext.supportedProtocolVersions?.length
      ? { supportedProtocolVersions: apiContext.supportedProtocolVersions }
      : {}),
    ...(protocolVersions
      ? { mcpProtocolVersionsByServerId: protocolVersions }
      : {}),
    // Only `false` reaches the wire; see `ApiContext.mirrorToolParamHeaders`.
    ...conformanceWireFields(apiContext),
    ...(apiContext.xaaPolicy ? { xaaPolicy: apiContext.xaaPolicy } : {}),
    ...(input.oauthTokens ? { oauthTokens: input.oauthTokens } : {}),
    ...(input.accessScope ? { accessScope: input.accessScope } : {}),
    ...(input.scenarioId ? { scenarioId: input.scenarioId } : {}),
    ...(input.scenarioId && Number.isFinite(input.accessVersion)
      ? { accessVersion: input.accessVersion }
      : {}),
  };
}

export function buildHostedEvalServerBatchRequest(serverNamesOrIds: string[]): {
  projectId: string;
  serverIds: string[];
  serverNames: string[];
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  mirrorToolParamHeaders?: boolean;
  firstPageOnly?: true;
  supportsMrtr?: false;
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  suppressLegacyRequestCancellation?: true;
  suppressModernRequestCancellation?: true;
  xaaPolicy?: XaaEnterprisePolicy;
  oauthTokens?: Record<string, string>;
  accessScope?: HostedAccessScope;
  scenarioId?: string;
  accessVersion?: number;
} {
  assertClientConfigSynced();
  const projectId = getHostedProjectId();
  const serverEntries = resolveHostedServerEntries(serverNamesOrIds);
  const serverIds = serverEntries.map((entry) => entry.serverId);
  const serverNames = serverEntries.map((entry) => entry.serverName);
  const oauthTokens = buildHostedOAuthTokensMap(serverIds);
  const protocolVersions = buildBatchProtocolVersionMap(serverIds);
  const scenarioId = getHostedScenarioId();
  const accessVersion = getHostedScenarioAccessVersion();
  const accessScope = getHostedAccessScope();

  return {
    projectId,
    serverIds,
    serverNames,
    ...(apiContext.clientCapabilities
      ? { clientCapabilities: apiContext.clientCapabilities }
      : {}),
    ...(apiContext.clientInfo ? { clientInfo: apiContext.clientInfo } : {}),
    ...(apiContext.supportedProtocolVersions?.length
      ? { supportedProtocolVersions: apiContext.supportedProtocolVersions }
      : {}),
    ...(protocolVersions
      ? { mcpProtocolVersionsByServerId: protocolVersions }
      : {}),
    // Only `false` reaches the wire; see `ApiContext.mirrorToolParamHeaders`.
    ...conformanceWireFields(apiContext),
    ...(apiContext.xaaPolicy ? { xaaPolicy: apiContext.xaaPolicy } : {}),
    ...(oauthTokens ? { oauthTokens } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(scenarioId && Number.isFinite(accessVersion) ? { accessVersion } : {}),
  };
}

export function buildHostedOAuthTokensMap(
  serverIds: string[]
): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const id of serverIds) {
    const token = getHostedOAuthToken(id);
    if (token) map[id] = token;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function awaitSessionBearerToken(): Promise<string | null> {
  pendingSessionBearer ??= pollForSessionBearerToken().finally(() => {
    pendingSessionBearer = null;
  });
  return pendingSessionBearer;
}

async function pollForSessionBearerToken(): Promise<string | null> {
  const deadline = Date.now() + SESSION_BEARER_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SESSION_BEARER_POLL_MS));

    // The actor can resolve to a guest while we wait — AuthKit deciding there
    // was no session after all, or a sign-out. Hand back to the guest path
    // instead of waiting out a token that is never coming.
    if (hasHostedGuestAccess()) return null;

    const getAccessToken = apiContext.getAccessToken;
    if (!getAccessToken) continue;
    try {
      const token = await getAccessToken();
      if (token) return token;
    } catch {
      // Still resolving (LoginRequiredError) — keep asking until the deadline.
    }
  }

  return null;
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
    // A WorkOS session exists, but its access token was not available above.
    // That is usually timing, not absence: AuthKit is mid-bootstrap or
    // mid-refresh. Returning null here let the request go out with NO
    // `Authorization` header, and the hosted routes answer that with their own
    // 401 ("Bearer token required") — which nothing retries, because
    // `shouldRetryApiAuth401` deliberately refuses to swap a resolving session
    // for a guest bearer. Wait for the token rather than firing and failing.
    const sessionToken = await awaitSessionBearerToken();
    if (sessionToken) {
      cachedBearerToken = {
        token: sessionToken,
        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
      };
      return `Bearer ${sessionToken}`;
    }
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
