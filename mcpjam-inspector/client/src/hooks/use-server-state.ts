import { useCallback, useEffect, useMemo, useRef, type Dispatch } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import type { HttpServerConfig, MCPServerConfig } from "@mcpjam/sdk/browser";
import type {
  AppAction,
  AppState,
  ServerWithName,
  Project,
} from "@/state/app-types";
import {
  testConnection,
  deleteServer,
  listServers,
  reconnectServer,
  getInitializationInfo,
} from "@/state/mcp-api";
import {
  ensureAuthorizedForReconnect,
  type OAuthResult,
} from "@/state/oauth-orchestrator";
import type { ServerFormData } from "@/shared/types.js";
import { toMCPConfig } from "@/state/server-helpers";
import {
  completeHostedOAuthCallback,
  handleOAuthCallback,
  getStoredTokens,
  clearOAuthData,
  initiateOAuth,
  readStoredOAuthConfig,
} from "@/lib/oauth/mcp-oauth";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";
import {
  clearHostedOAuthPendingState,
  getHostedOAuthCallbackContext,
  writeHostedOAuthPendingMarker,
} from "@/lib/hosted-oauth-callback";
import { HOSTED_MODE } from "@/lib/config";
import {
  injectHostedServerMapping,
  tryGetHostedServerDisplayName,
  tryResolveProjectServer,
} from "@/lib/apis/web/context";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import { authFetch } from "@/lib/session-token";
import { useProjectClientConfigSyncPending } from "./use-project-client-config-sync-pending";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useServerMutations, type RemoteServer } from "./useProjects";
import {
  CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
  PROJECT_NOT_PROVISIONED_ERROR_MESSAGE,
  getEffectiveProjectConnectionDefaults,
  mergeProjectConnectionHeaders,
  resolveEffectiveServerClientCapabilities,
} from "@/lib/client-config";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import { readOnboardingState } from "@/lib/onboarding-state";

/** Skip noisy connect toast while first-run App Builder onboarding is in progress. */
function shouldSuppressExcalidrawConnectToastForOnboarding(
  serverName: string
): boolean {
  if (serverName !== EXCALIDRAW_SERVER_NAME) return false;
  const status = readOnboardingState()?.status;
  return status === "seen";
}

function extractRequestHeaders(
  requestInit: RequestInit | undefined
): Record<string, string> | undefined {
  const headers = requestInit?.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;
}

function omitAuthorizationHeader(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) =>
        key.toLowerCase() !== "authorization" && typeof value === "string"
    )
  );

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function mergeOAuthCallbackServerConfig(
  existingConfig: MCPServerConfig | undefined,
  callbackConfig: HttpServerConfig
): HttpServerConfig {
  const existingHttpConfig =
    existingConfig && "url" in existingConfig ? existingConfig : undefined;
  const mergedHeaders = {
    ...(omitAuthorizationHeader(
      extractRequestHeaders(existingHttpConfig?.requestInit)
    ) ?? {}),
    ...(extractRequestHeaders(callbackConfig.requestInit) ?? {}),
  };
  const nextRequestInit =
    existingHttpConfig?.requestInit || callbackConfig.requestInit
      ? {
          ...(existingHttpConfig?.requestInit ?? {}),
          ...(callbackConfig.requestInit ?? {}),
          ...(Object.keys(mergedHeaders).length > 0
            ? { headers: mergedHeaders }
            : {}),
        }
      : undefined;

  return {
    ...(existingHttpConfig ?? {}),
    ...callbackConfig,
    ...(nextRequestInit ? { requestInit: nextRequestInit } : {}),
    timeout: callbackConfig.timeout ?? existingHttpConfig?.timeout,
    capabilities:
      callbackConfig.capabilities ?? existingHttpConfig?.capabilities,
    clientCapabilities:
      callbackConfig.clientCapabilities ??
      existingHttpConfig?.clientCapabilities ??
      callbackConfig.capabilities ??
      existingHttpConfig?.capabilities,
  };
}

/**
 * Saves OAuth-related configuration to localStorage for reconnection purposes.
 * This persists server URL, scopes, headers, and client credentials.
 */
function saveOAuthConfigToLocalStorage(formData: ServerFormData): void {
  if (HOSTED_MODE) {
    return;
  }

  if (formData.type !== "http" || !formData.useOAuth || !formData.url) {
    return;
  }

  localStorage.setItem(`mcp-serverUrl-${formData.name}`, formData.url);

  const oauthConfig: Record<string, unknown> = {};
  const existingOAuthConfig = readStoredOAuthConfig(formData.name);
  const protocolMode = formData.oauthProtocolMode ?? "auto";
  const registrationMode =
    formData.oauthRegistrationMode ??
    (formData.clientId || formData.clientSecret ? "preregistered" : "auto");

  oauthConfig.protocolMode = protocolMode;
  oauthConfig.registrationMode = registrationMode;
  if (protocolMode !== "auto") {
    oauthConfig.protocolVersion = protocolMode;
  }
  if (formData.oauthScopes && formData.oauthScopes.length > 0) {
    oauthConfig.scopes = formData.oauthScopes;
  }
  if (formData.headers && Object.keys(formData.headers).length > 0) {
    oauthConfig.customHeaders = formData.headers;
  }
  if (formData.registryServerId) {
    oauthConfig.registryServerId = formData.registryServerId;
  }
  if (registrationMode !== "auto") {
    oauthConfig.registrationStrategy = registrationMode;
  }
  if (existingOAuthConfig.resourceUrl) {
    oauthConfig.resourceUrl = existingOAuthConfig.resourceUrl;
  }
  if (Object.keys(oauthConfig).length > 0) {
    localStorage.setItem(
      `mcp-oauth-config-${formData.name}`,
      JSON.stringify(oauthConfig)
    );
  }

  if (formData.clientId || (!HOSTED_MODE && formData.clientSecret)) {
    const clientInfo: Record<string, string> = {};
    if (formData.clientId) {
      clientInfo.client_id = formData.clientId;
    }
    if (!HOSTED_MODE && formData.clientSecret) {
      clientInfo.client_secret = formData.clientSecret;
    }
    localStorage.setItem(
      `mcp-client-${formData.name}`,
      JSON.stringify(clientInfo)
    );
  } else {
    localStorage.removeItem(`mcp-client-${formData.name}`);
  }
}

function readStoredClientCredentials(serverName: string): {
  clientId?: string;
  clientSecret?: string;
} {
  try {
    const raw = localStorage.getItem(`mcp-client-${serverName}`);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return {
      clientId:
        typeof parsed?.client_id === "string" && parsed.client_id.trim() !== ""
          ? parsed.client_id
          : undefined,
      clientSecret:
        !HOSTED_MODE &&
        typeof parsed?.client_secret === "string" &&
        parsed.client_secret.trim() !== ""
          ? parsed.client_secret
          : undefined,
    };
  } catch {
    return {};
  }
}

function parseOAuthScopes(scopes?: string): string[] | undefined {
  const parsed = scopes
    ?.split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function profileHeadersToRecord(
  headers?: Array<{ key: string; value: string }>
): Record<string, string> | undefined {
  const entries = headers
    ?.map(({ key, value }) => [key.trim(), value] as const)
    .filter(([key, value]) => key && value);

  return entries && entries.length > 0
    ? Object.fromEntries(entries)
    : undefined;
}

function buildResolvedOAuthProfile(input: {
  serverName: string;
  serverUrl: string;
  existingProfile?: OAuthTestProfile;
  storedOAuthConfig: ReturnType<typeof readStoredOAuthConfig>;
  storedClientCredentials: ReturnType<typeof readStoredClientCredentials>;
  oauthResourceUrl?: string;
}): OAuthTestProfile | undefined {
  const existingProfile = input.existingProfile;
  const storedOAuthConfig = input.storedOAuthConfig;
  const storedClientCredentials = input.storedClientCredentials;

  const protocolVersion =
    existingProfile?.protocolVersion ??
    storedOAuthConfig.protocolVersion ??
    (storedOAuthConfig.protocolMode && storedOAuthConfig.protocolMode !== "auto"
      ? storedOAuthConfig.protocolMode
      : undefined);
  const registrationStrategy =
    existingProfile?.registrationStrategy ??
    storedOAuthConfig.registrationStrategy ??
    (storedOAuthConfig.registrationMode &&
    storedOAuthConfig.registrationMode !== "auto"
      ? storedOAuthConfig.registrationMode
      : undefined);

  if (!protocolVersion || !registrationStrategy) {
    return existingProfile;
  }

  const customHeaders = existingProfile?.customHeaders?.length
    ? existingProfile.customHeaders
    : Object.entries(storedOAuthConfig.customHeaders ?? {}).map(
        ([key, value]) => ({
          key,
          value,
        })
      );

  return {
    serverUrl: input.serverUrl,
    resourceUrl:
      input.oauthResourceUrl ??
      existingProfile?.resourceUrl ??
      storedOAuthConfig.resourceUrl ??
      "",
    clientId:
      existingProfile?.clientId ?? storedClientCredentials.clientId ?? "",
    clientSecret:
      existingProfile?.clientSecret ??
      storedClientCredentials.clientSecret ??
      "",
    scopes:
      existingProfile?.scopes ?? storedOAuthConfig.scopes?.join(",") ?? "",
    customHeaders,
    protocolVersion,
    registrationStrategy,
  };
}

function buildOAuthProfileFromFormData(
  formData: ServerFormData,
  existingProfile?: OAuthTestProfile
): OAuthTestProfile | undefined {
  if (formData.type !== "http" || !formData.useOAuth || !formData.url) {
    return undefined;
  }

  const protocolVersion =
    formData.oauthProtocolMode && formData.oauthProtocolMode !== "auto"
      ? formData.oauthProtocolMode
      : existingProfile?.protocolVersion ?? "2025-11-25";
  const registrationStrategy =
    formData.oauthRegistrationMode && formData.oauthRegistrationMode !== "auto"
      ? formData.oauthRegistrationMode
      : existingProfile?.registrationStrategy ??
        (formData.clientId || formData.clientSecret || formData.hasClientSecret
          ? "preregistered"
          : "dcr");
  const customHeaders = Object.entries(formData.headers ?? {})
    .filter(([key, value]) => key.trim() && value)
    .map(([key, value]) => ({ key, value }));

  return {
    serverUrl: formData.url,
    resourceUrl: existingProfile?.resourceUrl ?? "",
    clientId: formData.clientId ?? existingProfile?.clientId ?? "",
    clientSecret: HOSTED_MODE
      ? ""
      : formData.clientSecret ?? existingProfile?.clientSecret ?? "",
    scopes: formData.oauthScopes?.join(",") ?? existingProfile?.scopes ?? "",
    customHeaders,
    protocolVersion,
    registrationStrategy,
  };
}

function restorePathAfterOAuthCallback(
  currentPathname: string,
  savedHash: string
): string {
  const basePath =
    currentPathname === "/oauth/callback" ? "/" : currentPathname;
  return `${basePath}${savedHash}`;
}

function requiresFreshOAuthAuthorization(error: unknown): boolean {
  const errorMessage =
    typeof error === "string"
      ? error
      : error instanceof Error
      ? error.message
      : "";

  if (!errorMessage) {
    return false;
  }

  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("requires oauth authentication") ||
    normalized.includes(
      "stored hosted oauth credential is missing refresh_token"
    ) ||
    (normalized.includes("authentication failed") &&
      normalized.includes("invalid_token"))
  );
}

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

interface RegistryOAuthConfigResponse {
  clientId?: string;
  scopes?: string[];
}

interface ResolvedOAuthInitiationInputs {
  clientId?: string;
  clientSecret?: string;
  hasClientSecret: boolean;
  registryServerId?: string;
  scopes?: string[];
  useRegistryOAuthProxy: boolean;
}

interface UseServerStateParams {
  appState: AppState;
  dispatch: Dispatch<AppAction>;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True when a signed-in WorkOS user is present (not guest Convex-only auth). */
  hasSignedInUser: boolean;
  isAuthLoading: boolean;
  isLoadingProjects: boolean;
  useLocalFallback: boolean;
  effectiveProjects: Record<string, Project>;
  effectiveActiveProjectId: string;
  activeProjectServersFlat: RemoteServer[] | undefined;
  logger: LoggerLike;
}

export type PersistRuntimeServerResult =
  | "noop"
  | "pending"
  | "persisted"
  | "skipped_existing_name"
  | "skipped_project_servers_unresolved"
  | "failed";

const PROJECT_SERVERS_SNAPSHOT_WAIT_MS = 10_000;
/** Must stay below Vitest's default 30s test timeout so callers can finish after a full wait + margin. */
const PROJECT_SERVER_ECHO_WAIT_MS = 25_000;
const PROJECT_SERVERS_POLL_MS = 100;

export interface ServerUpdateResult {
  ok: boolean;
  serverName: string;
}

type EnsureServerConnectionStatus =
  | "connected"
  | "failed"
  | "missing"
  | "reauth";

interface EnsureServerConnectionResult {
  status: EnsureServerConnectionStatus;
  error?: string;
}

interface ReconnectServerInternalOptions {
  forceOAuthFlow?: boolean;
  allowInteractiveOAuthFlow?: boolean;
  select?: boolean;
  suppressErrors?: boolean;
}

export interface EnsureServersReadyResult {
  readyServerNames: string[];
  missingServerNames: string[];
  failedServerNames: string[];
  reauthServerNames: string[];
}

export function useServerState({
  appState,
  dispatch,
  isLoading,
  isAuthenticated,
  hasSignedInUser,
  isAuthLoading,
  isLoadingProjects,
  useLocalFallback,
  effectiveProjects,
  effectiveActiveProjectId,
  activeProjectServersFlat,
  logger,
}: UseServerStateParams) {
  const convex = useConvex();
  const {
    createServer: convexCreateServer,
    updateServer: convexUpdateServer,
    createServerWithClientSecret: convexCreateServerWithClientSecret,
    updateServerWithClientSecret: convexUpdateServerWithClientSecret,
    deleteServer: convexDeleteServer,
  } = useServerMutations();

  const hasSignedInUserRef = useRef(hasSignedInUser);
  hasSignedInUserRef.current = hasSignedInUser;
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const isAuthLoadingRef = useRef(isAuthLoading);
  isAuthLoadingRef.current = isAuthLoading;
  const isLoadingProjectsRef = useRef(isLoadingProjects);
  isLoadingProjectsRef.current = isLoadingProjects;
  const useLocalFallbackRef = useRef(useLocalFallback);
  useLocalFallbackRef.current = useLocalFallback;
  const effectiveActiveProjectIdRef = useRef(effectiveActiveProjectId);
  effectiveActiveProjectIdRef.current = effectiveActiveProjectId;
  const appStateServersRef = useRef(appState.servers);
  appStateServersRef.current = appState.servers;
  const activeProjectServersFlatRef = useRef(activeProjectServersFlat);
  activeProjectServersFlatRef.current = activeProjectServersFlat;
  const persistRuntimeDedupeKeysRef = useRef<Set<string>>(new Set());

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  const oauthCallbackHandledRef = useRef(false);
  const opTokenRef = useRef<Map<string, number>>(new Map());
  const nextOpToken = (name: string) => {
    const current = opTokenRef.current.get(name) ?? 0;
    const next = current + 1;
    opTokenRef.current.set(name, next);
    return next;
  };

  const failPendingOAuthConnection = useCallback(
    (errorMessage: string, oauthTrace?: OAuthTrace) => {
      const pendingServerName = localStorage.getItem("mcp-oauth-pending");
      if (pendingServerName) {
        dispatch({
          type: "CONNECT_FAILURE",
          name: pendingServerName,
          error: errorMessage,
          oauthTrace,
        });
      }

      clearHostedOAuthPendingState();
      localStorage.removeItem("mcp-oauth-return-hash");
      localStorage.removeItem("mcp-oauth-pending");

      return pendingServerName;
    },
    [dispatch]
  );
  const updateServerOAuthTrace = useCallback(
    (serverName: string, oauthTrace: OAuthTrace) => {
      dispatch({
        type: "SET_SERVER_OAUTH_TRACE",
        name: serverName,
        oauthTrace,
      });
    },
    [dispatch]
  );
  const isStaleOp = (name: string, token: number) =>
    (opTokenRef.current.get(name) ?? 0) !== token;

  const prepareHostedProjectOAuthRedirect = useCallback(
    (params: {
      serverId?: string | null;
      serverName: string;
      serverUrl?: string | null;
    }): boolean => {
      if (
        !HOSTED_MODE ||
        !isAuthenticated ||
        !effectiveActiveProjectId ||
        !params.serverId ||
        !params.serverUrl
      ) {
        return false;
      }

      const returnHash = window.location.hash || "#servers";
      const organizationId =
        effectiveProjects[effectiveActiveProjectId]?.organizationId ?? null;
      clearHostedOAuthPendingState();
      writeHostedOAuthPendingMarker({
        surface: "project",
        organizationId,
        projectId: effectiveActiveProjectId,
        serverId: params.serverId,
        serverName: params.serverName,
        serverUrl: params.serverUrl,
        accessScope: "project_member",
        returnHash,
      });
      localStorage.setItem("mcp-oauth-return-hash", returnHash);
      return true;
    },
    [effectiveActiveProjectId, effectiveProjects, isAuthenticated]
  );

  const activeProject = useMemo(() => {
    const project = effectiveProjects[effectiveActiveProjectId];
    if (!project) {
      return undefined;
    }

    const serversWithRuntime: Record<string, ServerWithName> = {};
    for (const [name, server] of Object.entries(project.servers)) {
      const runtimeState = appState.servers[name];
      // Env now lives on the Convex server doc and is returned by the
      // resolver inside `server.config.env`; no localStorage read needed.
      serversWithRuntime[name] = {
        ...server,
        config: server.config,
        connectionStatus: runtimeState?.connectionStatus || "disconnected",
        oauthTokens: runtimeState?.oauthTokens,
        initializationInfo: runtimeState?.initializationInfo,
        lastConnectionTime:
          runtimeState?.lastConnectionTime || server.lastConnectionTime,
        retryCount: runtimeState?.retryCount || 0,
      };
    }

    // Surface runtime-only servers (e.g. registered via the CLI's
    // /api/mcp/connect before they have been persisted to a project) so they
    // participate in selection, status display, and command routing. Without
    // this, the App.tsx auto-select effect would override an explicit
    // setSelectedServer because effectiveServers[<runtime-only>]?.config is
    // undefined.
    for (const [name, runtime] of Object.entries(appState.servers)) {
      if (serversWithRuntime[name]) continue;
      if (
        runtime.connectionStatus !== "connected" &&
        runtime.connectionStatus !== "connecting"
      ) {
        continue;
      }
      serversWithRuntime[name] = runtime;
    }

    return { ...project, servers: serversWithRuntime };
  }, [effectiveProjects, effectiveActiveProjectId, appState.servers]);

  const effectiveServers = useMemo(() => {
    return activeProject?.servers || {};
  }, [activeProject]);

  const connectedOrConnectingServerConfigs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(effectiveServers).filter(
          ([, server]) =>
            server.connectionStatus === "connected" ||
            server.connectionStatus === "connecting"
        )
      ),
    [effectiveServers]
  );
  const latestEffectiveServersRef = useRef(effectiveServers);

  useEffect(() => {
    latestEffectiveServersRef.current = effectiveServers;
  }, [effectiveServers]);

  const isClientConfigSyncPending = useProjectClientConfigSyncPending(
    effectiveActiveProjectId
  );

  const projectConnectionDefaults = useMemo(
    () => getEffectiveProjectConnectionDefaults(activeProject?.clientConfig),
    [activeProject?.clientConfig]
  );

  const withProjectConnectionDefaults = useCallback(
    (serverConfig: MCPServerConfig): MCPServerConfig => {
      const effectiveClientCapabilities =
        resolveEffectiveServerClientCapabilities({
          serverConfig,
          projectClientConfig: activeProject?.clientConfig,
        });

      let nextRequestInit = serverConfig.requestInit;
      if ("url" in serverConfig) {
        const mergedHeaders = mergeProjectConnectionHeaders(
          projectConnectionDefaults.headers,
          extractRequestHeaders(serverConfig.requestInit)
        );

        if (Object.keys(mergedHeaders).length > 0) {
          nextRequestInit = {
            ...(serverConfig.requestInit ?? {}),
            headers: mergedHeaders,
          };
        }
      }

      return {
        ...serverConfig,
        ...("url" in serverConfig && nextRequestInit
          ? { requestInit: nextRequestInit }
          : {}),
        timeout:
          serverConfig.timeout ?? projectConnectionDefaults.requestTimeout,
        capabilities: effectiveClientCapabilities,
        clientCapabilities: effectiveClientCapabilities,
      };
    },
    [activeProject?.clientConfig, projectConnectionDefaults]
  );

  const mergeWithProjectHeaders = useCallback(
    (headers?: Record<string, string>) => {
      const merged = mergeProjectConnectionHeaders(
        projectConnectionDefaults.headers,
        omitAuthorizationHeader(headers)
      );
      return Object.keys(merged).length > 0 ? merged : undefined;
    },
    [projectConnectionDefaults.headers]
  );

  const assertClientConfigSynced = useCallback(() => {
    if (!isClientConfigSyncPending) {
      return;
    }

    throw new Error(CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE);
  }, [isClientConfigSyncPending]);

  const notifyIfClientConfigSyncPending = useCallback(() => {
    if (!isClientConfigSyncPending) {
      return false;
    }

    toast.error(CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE);
    return true;
  }, [isClientConfigSyncPending]);

  const isProjectProvisioned = useMemo(
    () => Boolean(activeProject?.sharedProjectId),
    [activeProject?.sharedProjectId]
  );

  const getProjectNotProvisionedError = useCallback(() => {
    if (isProjectProvisioned) {
      return null;
    }
    if (useLocalFallbackRef.current || !isAuthenticatedRef.current) {
      return null;
    }
    return PROJECT_NOT_PROVISIONED_ERROR_MESSAGE;
  }, [isProjectProvisioned]);

  const notifyIfProjectNotProvisioned = useCallback(() => {
    const errorMessage = getProjectNotProvisionedError();
    if (!errorMessage) {
      return false;
    }

    toast.error(errorMessage);
    return true;
  }, [getProjectNotProvisionedError]);

  // Extract runtime overlay applied by `withProjectConnectionDefaults` so the
  // resolver path can reproduce them server-side. Without this, the resolver
  // sees only the Convex-stored per-server config and loses project-level
  // header overlays / timeout / capabilities. HTTP servers' Authorization is
  // omitted here — OAuth bearer is reattached server-side from the Convex
  // token store.
  const buildResolverConnectionDefaults = useCallback(
    (serverConfig: MCPServerConfig) => {
      const defaults: {
        headers?: Record<string, string>;
        timeoutMs?: number;
        clientCapabilities?: Record<string, unknown>;
      } = {};
      if ("url" in serverConfig) {
        const headers = omitAuthorizationHeader(
          extractRequestHeaders(serverConfig.requestInit)
        );
        if (headers && Object.keys(headers).length > 0) {
          defaults.headers = headers;
        }
      }
      if (typeof serverConfig.timeout === "number") {
        defaults.timeoutMs = serverConfig.timeout;
      }
      const caps = serverConfig.clientCapabilities as
        | Record<string, unknown>
        | undefined;
      if (caps && typeof caps === "object") defaults.clientCapabilities = caps;
      return Object.keys(defaults).length > 0 ? defaults : undefined;
    },
    []
  );

  const guardedTestConnection = useCallback(
    async (serverConfig: MCPServerConfig, serverName: string) => {
      assertClientConfigSynced();
      // Opt into the resolver path when both projectId and a Convex serverId
      // are populated in the API context; otherwise fall back to legacy
      // {serverConfig, serverId} so brand-new servers (not yet synced to
      // Convex) keep working. The 2-arg call signature is preserved when no
      // resolver context is available so existing test mocks keep matching.
      const resolved = tryResolveProjectServer(serverName);
      if (resolved) {
        return testConnection(serverConfig, resolved.serverId, {
          projectId: resolved.projectId,
          serverName,
          connectionDefaults: buildResolverConnectionDefaults(serverConfig),
        });
      }
      throw new Error(PROJECT_NOT_PROVISIONED_ERROR_MESSAGE);
    },
    [assertClientConfigSynced, buildResolverConnectionDefaults]
  );

  const guardedReconnectServer = useCallback(
    async (serverName: string, serverConfig: MCPServerConfig) => {
      assertClientConfigSynced();
      const resolved = tryResolveProjectServer(serverName);
      if (resolved) {
        return reconnectServer(resolved.serverId, serverConfig, {
          projectId: resolved.projectId,
          serverName,
          connectionDefaults: buildResolverConnectionDefaults(serverConfig),
        });
      }
      throw new Error(PROJECT_NOT_PROVISIONED_ERROR_MESSAGE);
    },
    [assertClientConfigSynced, buildResolverConnectionDefaults]
  );

  const validateForm = (formData: ServerFormData): string | null => {
    if (formData.type === "stdio") {
      if (!formData.command || formData.command.trim() === "") {
        return "Command is required for STDIO connections";
      }
      return null;
    }
    if (!formData.url || formData.url.trim() === "") {
      return "URL is required for HTTP connections";
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(formData.url);
    } catch (err) {
      return `Invalid URL format: ${formData.url} ${err}`;
    }
    if (HOSTED_MODE && parsedUrl.protocol !== "https:") {
      return "Hosted mode requires HTTPS server URLs";
    }
    return null;
  };

  const setSelectedMultipleServersToAllServers = useCallback(() => {
    const connectedNames = Object.entries(appState.servers)
      .filter(([, s]) => s.connectionStatus === "connected")
      .map(([name]) => name);
    dispatch({ type: "SET_MULTI_SELECTED", names: connectedNames });
  }, [appState.servers, dispatch]);

  const syncServerToConvex = useCallback(
    async (
      serverName: string,
      serverEntry: ServerWithName,
      secretOptions?: { clientSecret?: string; clearClientSecret?: boolean }
    ): Promise<string | undefined> => {
      const latestUseLocalFallback = useLocalFallbackRef.current;
      const latestIsAuthenticated = isAuthenticatedRef.current;
      const latestProjectId = effectiveActiveProjectIdRef.current;
      if (
        latestUseLocalFallback ||
        !latestIsAuthenticated ||
        !latestProjectId ||
        latestProjectId === "none"
      ) {
        return undefined;
      }

      const flatSnapshot =
        activeProjectServersFlatRef.current ?? activeProjectServersFlat;

      const clientSecret = secretOptions?.clientSecret?.trim();
      const clearClientSecret = secretOptions?.clearClientSecret === true;
      if (clientSecret && clearClientSecret) {
        throw new Error(
          "Cannot replace and clear the OAuth client secret in the same save."
        );
      }
      const hasSecretOperation = Boolean(clientSecret || clearClientSecret);

      const existingServer = flatSnapshot?.find((s) => s.name === serverName);

      const config = serverEntry.config as any;
      const transportType = config?.command ? "stdio" : "http";
      const url =
        config?.url instanceof URL ? config.url.href : config?.url || undefined;
      const headers = config?.requestInit?.headers || undefined;
      const storedOAuthConfig = readStoredOAuthConfig(serverName);

      const payload = {
        name: serverName,
        enabled: serverEntry.enabled ?? false,
        transportType,
        command: config?.command,
        args: config?.args,
        url,
        headers,
        timeout: config?.timeout,
        clientCapabilities: config?.clientCapabilities,
        useOAuth: serverEntry.useOAuth,
        oauthScopes: serverEntry.oauthFlowProfile?.scopes
          ? serverEntry.oauthFlowProfile.scopes.split(",").filter(Boolean)
          : undefined,
        clientId: serverEntry.oauthFlowProfile?.clientId,
        oauthResourceUrl:
          serverEntry.oauthFlowProfile?.resourceUrl ||
          storedOAuthConfig.resourceUrl,
      } as const;

      try {
        if (existingServer) {
          const updatePayload = {
            serverId: existingServer._id,
            ...payload,
            ...(clientSecret ? { clientSecret } : {}),
            ...(clearClientSecret ? { clearClientSecret: true } : {}),
          };
          if (hasSecretOperation) {
            await convexUpdateServerWithClientSecret(updatePayload);
          } else {
            await convexUpdateServer(updatePayload);
          }
          return existingServer._id;
        }

        const createPayload = {
          projectId: latestProjectId,
          ...payload,
          ...(clientSecret ? { clientSecret } : {}),
        };
        const newId = clientSecret
          ? await convexCreateServerWithClientSecret(createPayload)
          : await convexCreateServer(createPayload);
        return newId as string | undefined;
      } catch (primaryError) {
        // Best-effort fallback for stale query snapshots:
        // if update failed, try create; if create failed, try update when possible.
        try {
          if (existingServer) {
            const createPayload = {
              projectId: latestProjectId,
              ...payload,
              ...(clientSecret ? { clientSecret } : {}),
            };
            const newId = clientSecret
              ? await convexCreateServerWithClientSecret(createPayload)
              : await convexCreateServer(createPayload);
            return newId as string | undefined;
          }
          const flatRetry =
            activeProjectServersFlatRef.current ?? activeProjectServersFlat;
          const retryExisting = flatRetry?.find((s) => s.name === serverName);
          if (retryExisting) {
            const updatePayload = {
              serverId: retryExisting._id,
              ...payload,
              ...(clientSecret ? { clientSecret } : {}),
              ...(clearClientSecret ? { clearClientSecret: true } : {}),
            };
            if (hasSecretOperation) {
              await convexUpdateServerWithClientSecret(updatePayload);
            } else {
              await convexUpdateServer(updatePayload);
            }
            return retryExisting._id;
          }
        } catch (fallbackError) {
          logger.error("Failed to sync server to Convex", {
            serverName,
            primaryError:
              primaryError instanceof Error
                ? primaryError.message
                : "Unknown error",
            fallbackError:
              fallbackError instanceof Error
                ? fallbackError.message
                : "Unknown error",
          });
          return undefined;
        }

        logger.error("Failed to sync server to Convex", {
          serverName,
          error:
            primaryError instanceof Error
              ? primaryError.message
              : "Unknown error",
        });
        return undefined;
      }
    },
    [
      activeProjectServersFlat,
      convexUpdateServer,
      convexCreateServer,
      convexUpdateServerWithClientSecret,
      convexCreateServerWithClientSecret,
      logger,
    ]
  );

  const persistRuntimeServerToProjectIfNeeded = useCallback(
    async (
      serverName: string,
      runtimeServerOverride?: ServerWithName
    ): Promise<PersistRuntimeServerResult> => {
      if (HOSTED_MODE) {
        return "noop";
      }
      const resolveRuntime = (): ServerWithName | undefined =>
        runtimeServerOverride ?? appStateServersRef.current[serverName];

      let runtime = resolveRuntime();
      if (!runtime) {
        return "noop";
      }
      if (runtime.connectionStatus !== "connected") {
        return "noop";
      }

      const initialProjectKey =
        effectiveActiveProjectIdRef.current ?? effectiveActiveProjectId;
      const frozenProjectId =
        initialProjectKey && initialProjectKey !== "none"
          ? initialProjectKey
          : null;
      let dedupeKey = `${frozenProjectId ?? "pending"}:${serverName}`;

      if (persistRuntimeDedupeKeysRef.current.has(dedupeKey)) {
        return "pending";
      }

      persistRuntimeDedupeKeysRef.current.add(dedupeKey);

      const clearDedupeKey = () => {
        persistRuntimeDedupeKeysRef.current.delete(dedupeKey);
      };

      const rekeyDedupe = (resolvedProjectId: string): boolean => {
        const nextKey = `${resolvedProjectId}:${serverName}`;
        if (nextKey === dedupeKey) {
          return true;
        }
        if (persistRuntimeDedupeKeysRef.current.has(nextKey)) {
          persistRuntimeDedupeKeysRef.current.delete(dedupeKey);
          return false;
        }
        persistRuntimeDedupeKeysRef.current.delete(dedupeKey);
        persistRuntimeDedupeKeysRef.current.add(nextKey);
        dedupeKey = nextKey;
        return true;
      };

      let projectId: string | null = null;
      try {
        const readyStarted = Date.now();
        while (Date.now() - readyStarted < PROJECT_SERVERS_SNAPSHOT_WAIT_MS) {
          if (isAuthLoadingRef.current || isLoadingProjectsRef.current) {
            await sleep(PROJECT_SERVERS_POLL_MS);
            continue;
          }

          if (
            !hasSignedInUserRef.current ||
            !isAuthenticatedRef.current ||
            useLocalFallbackRef.current
          ) {
            clearDedupeKey();
            return "noop";
          }

          const latestProjectId = effectiveActiveProjectIdRef.current;
          if (latestProjectId && latestProjectId !== "none") {
            if (frozenProjectId && latestProjectId !== frozenProjectId) {
              clearDedupeKey();
              return "noop";
            }
            if (!rekeyDedupe(latestProjectId)) {
              return "pending";
            }
            projectId = latestProjectId;
            break;
          }

          await sleep(PROJECT_SERVERS_POLL_MS);
        }

        if (!projectId) {
          if (
            !hasSignedInUserRef.current ||
            !isAuthenticatedRef.current ||
            useLocalFallbackRef.current
          ) {
            clearDedupeKey();
            return "noop";
          }
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: auth/project state did not become ready in time; skipping Convex write",
            { serverName }
          );
          clearDedupeKey();
          return "skipped_project_servers_unresolved";
        }

        const startedWait = Date.now();
        while (Date.now() - startedWait < PROJECT_SERVERS_SNAPSHOT_WAIT_MS) {
          const flat = activeProjectServersFlatRef.current;
          if (flat !== undefined) {
            break;
          }
          await sleep(PROJECT_SERVERS_POLL_MS);
        }

        const flatAfterWait = activeProjectServersFlatRef.current;
        if (flatAfterWait === undefined) {
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: project server snapshot still unresolved; skipping Convex write",
            { serverName, projectId }
          );
          clearDedupeKey();
          return "skipped_project_servers_unresolved";
        }

        if (
          effectiveActiveProjectIdRef.current &&
          effectiveActiveProjectIdRef.current !== projectId
        ) {
          clearDedupeKey();
          return "noop";
        }

        const liveRuntime = appStateServersRef.current[serverName];
        if (!liveRuntime || liveRuntime.connectionStatus !== "connected") {
          clearDedupeKey();
          return "noop";
        }
        runtime = liveRuntime;

        if (flatAfterWait.some((s) => s.name === serverName)) {
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: runtime server not persisted because a saved server with the same name already exists",
            { serverName, projectId }
          );
          clearDedupeKey();
          return "skipped_existing_name";
        }

        let convexResult: string | undefined;
        try {
          convexResult = await syncServerToConvex(serverName, runtime);
        } catch (syncError) {
          logger.error(
            "persistRuntimeServerToProjectIfNeeded: syncServerToConvex threw",
            {
              serverName,
              projectId,
              phase: "syncServerToConvex",
              error:
                syncError instanceof Error
                  ? syncError.message
                  : "Unknown error",
            }
          );
          clearDedupeKey();
          return "failed";
        }

        if (convexResult === undefined) {
          logger.error(
            "persistRuntimeServerToProjectIfNeeded: syncServerToConvex returned no server id",
            {
              serverName,
              projectId,
              phase: "after_syncServerToConvex",
            }
          );
          clearDedupeKey();
          return "failed";
        }

        const echoStarted = Date.now();
        let echoed = false;
        while (Date.now() - echoStarted < PROJECT_SERVER_ECHO_WAIT_MS) {
          const flatEcho = activeProjectServersFlatRef.current;
          if (flatEcho?.some((s) => s.name === serverName)) {
            echoed = true;
            break;
          }
          await sleep(PROJECT_SERVERS_POLL_MS);
        }

        if (!echoed) {
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: timed out waiting for project server echo after persist",
            { serverName, projectId }
          );
        }

        clearDedupeKey();
        return "persisted";
      } catch (unexpected) {
        logger.error(
          "persistRuntimeServerToProjectIfNeeded: unexpected error",
          {
            serverName,
            projectId,
            error:
              unexpected instanceof Error
                ? unexpected.message
                : "Unknown error",
          }
        );
        clearDedupeKey();
        return "failed";
      }
    },
    [effectiveActiveProjectId, syncServerToConvex, logger]
  );

  const removeServerFromConvex = useCallback(
    async (serverName: string) => {
      if (useLocalFallback || !isAuthenticated || !effectiveActiveProjectId) {
        return;
      }

      const existingServer = activeProjectServersFlat?.find(
        (s) => s.name === serverName
      );

      if (!existingServer) {
        logger.warn("Server not found in Convex for deletion", { serverName });
        return;
      }

      try {
        await convexDeleteServer({
          serverId: existingServer._id,
        });
      } catch (error) {
        logger.error("Failed to remove server from Convex", {
          serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [
      useLocalFallback,
      isAuthenticated,
      effectiveActiveProjectId,
      activeProjectServersFlat,
      convexDeleteServer,
      logger,
    ]
  );

  const persistServerToLocalProject = useCallback(
    (
      serverName: string,
      serverEntry: ServerWithName,
      options?: { originalServerName?: string }
    ) => {
      const targetProjectId =
        effectiveActiveProjectId !== "none"
          ? effectiveActiveProjectId
          : appState.activeProjectId;

      if (!targetProjectId || targetProjectId === "none") {
        return;
      }

      const project =
        effectiveProjects[targetProjectId] ??
        appState.projects[targetProjectId];
      if (!project) {
        return;
      }

      const nextServers = { ...project.servers };
      if (
        options?.originalServerName &&
        options.originalServerName !== serverName
      ) {
        delete nextServers[options.originalServerName];
      }
      nextServers[serverName] = serverEntry;

      dispatch({
        type: "UPDATE_PROJECT",
        projectId: targetProjectId,
        updates: { servers: nextServers },
      });
    },
    [
      effectiveActiveProjectId,
      effectiveProjects,
      appState.activeProjectId,
      appState.projects,
      dispatch,
    ]
  );

  const fetchAndStoreInitInfo = useCallback(
    async (serverName: string) => {
      try {
        const result = await getInitializationInfo(serverName);
        if (result.success && result.initInfo) {
          dispatch({
            type: "SET_INITIALIZATION_INFO",
            name: serverName,
            initInfo: result.initInfo,
          });
        }
      } catch (error) {
        console.debug("Failed to fetch initialization info", {
          serverName,
          error,
        });
      }
    },
    [dispatch]
  );

  /**
   * Stores init info from an inline connection result, or falls back to
   * fetching it via a separate request. Callers can fire-and-forget (no await)
   * or await depending on whether they need it resolved before continuing.
   */
  const storeInitInfo = useCallback(
    async (
      serverName: string,
      initInfo: Record<string, unknown> | null | undefined
    ) => {
      if (initInfo) {
        dispatch({
          type: "SET_INITIALIZATION_INFO",
          name: serverName,
          initInfo,
        });
      } else {
        await fetchAndStoreInitInfo(serverName);
      }
    },
    [dispatch, fetchAndStoreInitInfo]
  );

  const resolveOAuthInitiationInputs = useCallback(
    async (
      formData: ServerFormData
    ): Promise<ResolvedOAuthInitiationInputs> => {
      let registryOAuthConfig: RegistryOAuthConfigResponse | null = null;

      if (formData.registryServerId) {
        try {
          registryOAuthConfig = (await convex.query(
            "registryServers:getRegistryServerOAuthConfig" as any,
            { registryServerId: formData.registryServerId } as any
          )) as RegistryOAuthConfigResponse | null;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          throw new Error(
            `Failed to resolve registry OAuth config: ${errorMessage}`
          );
        }
      }

      const clientId =
        typeof registryOAuthConfig?.clientId === "string" &&
        registryOAuthConfig.clientId.trim() !== ""
          ? registryOAuthConfig.clientId
          : formData.clientId;
      const scopes =
        Array.isArray(registryOAuthConfig?.scopes) &&
        registryOAuthConfig.scopes.every(
          (scope): scope is string => typeof scope === "string"
        )
          ? registryOAuthConfig.scopes
          : formData.oauthScopes;

      return {
        clientId,
        clientSecret: formData.clientSecret,
        hasClientSecret: Boolean(
          formData.clientSecret || formData.hasClientSecret
        ),
        registryServerId: formData.registryServerId,
        scopes,
        useRegistryOAuthProxy: Boolean(clientId && formData.registryServerId),
      };
    },
    [convex]
  );

  const handleOAuthCallbackComplete = useCallback(
    async (
      code: string,
      state: string | null,
      hostedCallbackContext: ReturnType<typeof getHostedOAuthCallbackContext>
    ) => {
      const pendingServerName = localStorage.getItem("mcp-oauth-pending");
      const isHostedProjectCallback =
        HOSTED_MODE &&
        isAuthenticated &&
        hostedCallbackContext?.surface === "project";
      const handleLiveOAuthTrace = (oauthTrace: OAuthTrace) => {
        const traceServerName =
          oauthTrace.serverName ??
          hostedCallbackContext?.serverName ??
          pendingServerName ??
          null;
        if (traceServerName) {
          updateServerOAuthTrace(traceServerName, oauthTrace);
        }
      };

      try {
        const result = isHostedProjectCallback
          ? await completeHostedOAuthCallback(hostedCallbackContext, code, {
              callbackState: state,
              onTraceUpdate: handleLiveOAuthTrace,
            })
          : await handleOAuthCallback(code, {
              onTraceUpdate: handleLiveOAuthTrace,
            });

        localStorage.removeItem("mcp-oauth-return-hash");
        if (isHostedProjectCallback) {
          clearHostedOAuthPendingState();
          localStorage.removeItem("mcp-oauth-pending");
        }

        if (result.success && result.serverConfig && result.serverName) {
          const serverName = result.serverName;
          const existingServer = latestEffectiveServersRef.current[serverName];
          const mergedServerConfig = mergeOAuthCallbackServerConfig(
            existingServer?.config,
            result.serverConfig
          );
          const storedOAuthConfig = readStoredOAuthConfig(serverName);
          const storedClientCredentials =
            readStoredClientCredentials(serverName);
          const resolvedOAuthProfile = buildResolvedOAuthProfile({
            serverName,
            serverUrl:
              mergedServerConfig.url instanceof URL
                ? mergedServerConfig.url.href
                : String(mergedServerConfig.url),
            existingProfile: existingServer?.oauthFlowProfile,
            storedOAuthConfig,
            storedClientCredentials,
            oauthResourceUrl: result.oauthResourceUrl,
          });
          const oauthServerEntry: ServerWithName = {
            ...(existingServer ?? {}),
            name: serverName,
            config: mergedServerConfig,
            lastConnectionTime:
              existingServer?.lastConnectionTime ?? new Date(),
            connectionStatus:
              existingServer?.connectionStatus ?? "disconnected",
            retryCount: existingServer?.retryCount ?? 0,
            enabled: existingServer?.enabled ?? true,
            oauthTokens: existingServer?.oauthTokens,
            oauthFlowProfile: resolvedOAuthProfile,
            hasClientSecret: existingServer?.hasClientSecret,
            initializationInfo: existingServer?.initializationInfo,
            useOAuth: true,
            lastOAuthTrace: result.oauthTrace,
          };

          dispatch({
            type: "UPSERT_SERVER",
            name: serverName,
            server: oauthServerEntry,
          });
          if (!isAuthenticated || useLocalFallback) {
            persistServerToLocalProject(serverName, oauthServerEntry);
          } else {
            syncServerToConvex(serverName, oauthServerEntry).catch((error) =>
              logger.warn("Failed to sync OAuth profile to Convex", {
                serverName,
                error,
              })
            );
          }

          dispatch({
            type: "CONNECT_REQUEST",
            name: serverName,
            config: mergedServerConfig,
            select: true,
          });

          try {
            const connectionResult = await guardedTestConnection(
              withProjectConnectionDefaults(mergedServerConfig),
              serverName
            );
            if (connectionResult.success) {
              dispatch({
                type: "CONNECT_SUCCESS",
                name: serverName,
                config: mergedServerConfig,
                tokens: isHostedProjectCallback
                  ? undefined
                  : getStoredTokens(serverName),
                useOAuth: true,
                oauthTrace: result.oauthTrace,
              });
              logger.info("OAuth connection successful", { serverName });
              toast.success(
                `OAuth connection successful! Connected to ${serverName}.`
              );
              storeInitInfo(serverName, connectionResult.initInfo).catch(
                (err) =>
                  logger.warn("Failed to fetch init info", {
                    serverName,
                    err,
                  })
              );
            } else {
              dispatch({
                type: "CONNECT_FAILURE",
                name: serverName,
                error:
                  connectionResult.error ||
                  "Connection test failed after OAuth",
                oauthTrace: result.oauthTrace,
              });
              logger.error("OAuth connection test failed", {
                serverName,
                error: connectionResult.error,
              });
              toast.error(
                `OAuth succeeded but connection test failed: ${connectionResult.error}`
              );
            }
          } catch (connectionError) {
            const errorMessage =
              connectionError instanceof Error
                ? connectionError.message
                : "Unknown connection error";
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: errorMessage,
              oauthTrace: result.oauthTrace,
            });
            logger.error("OAuth connection test error", {
              serverName,
              error: errorMessage,
            });
            toast.error(
              `OAuth succeeded but connection test failed: ${errorMessage}`
            );
          }
        } else {
          throw {
            message: result.error || "OAuth callback failed",
            oauthTrace: result.oauthTrace,
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === "object" &&
              error !== null &&
              "message" in error &&
              typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : "Unknown error";
        toast.error(`Error completing OAuth flow: ${errorMessage}`);
        logger.error("OAuth callback failed", { error: errorMessage });
        const oauthTrace =
          typeof error === "object" && error !== null && "oauthTrace" in error
            ? (error as { oauthTrace?: OAuthTrace }).oauthTrace
            : undefined;
        const failedServerName =
          failPendingOAuthConnection(errorMessage, oauthTrace) ??
          pendingServerName;
        if (failedServerName) {
          logger.warn("Marked pending OAuth connection as failed", {
            serverName: failedServerName,
            error: errorMessage,
          });
        }
      }
    },
    [
      dispatch,
      failPendingOAuthConnection,
      isAuthenticated,
      logger,
      persistServerToLocalProject,
      storeInitInfo,
      guardedTestConnection,
      syncServerToConvex,
      updateServerOAuthTrace,
      useLocalFallback,
      withProjectConnectionDefaults,
    ]
  );

  useEffect(() => {
    if (window.location.pathname.startsWith("/oauth/callback/debug")) {
      return;
    }

    if (isLoading) return;
    if (isAuthLoading) return;

    if (
      isAuthenticated &&
      !useLocalFallback &&
      (isLoadingProjects || !effectiveActiveProjectId)
    ) {
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const state = urlParams.get("state");
    const error = urlParams.get("error");
    const errorDescription = urlParams.get("error_description");
    const hostedOAuthCallbackContext = HOSTED_MODE
      ? getHostedOAuthCallbackContext()
      : null;
    const isHostedProjectCallback =
      hostedOAuthCallbackContext?.surface === "project";
    if (code) {
      if (hostedOAuthCallbackContext && !isHostedProjectCallback) {
        return; // Handled by App.tsx hosted OAuth interception
      }
      if (oauthCallbackHandledRef.current) {
        return;
      }
      oauthCallbackHandledRef.current = true;

      // Dispatch "connecting" immediately so SYNC_AGENT_STATUS (which fires
      // concurrently) cannot set the server back to "disconnected" while the
      // token exchange is still in flight.
      // Prefer the hostedOAuthCallbackContext server name (already validated),
      // fall back to the legacy localStorage key.
      const earlyPendingName =
        hostedOAuthCallbackContext?.serverName ??
        localStorage.getItem("mcp-oauth-pending");
      if (earlyPendingName) {
        const earlyServer = effectiveServers[earlyPendingName];
        if (earlyServer) {
          dispatch({
            type: "CONNECT_REQUEST",
            name: earlyPendingName,
            config: earlyServer.config,
            select: true,
          });
        }
      }

      const savedHash = localStorage.getItem("mcp-oauth-return-hash") || "";
      window.history.replaceState(
        {},
        document.title,
        restorePathAfterOAuthCallback(window.location.pathname, savedHash)
      );

      handleOAuthCallbackComplete(
        code,
        state,
        isHostedProjectCallback ? hostedOAuthCallbackContext : null
      );
    } else if (error) {
      if (hostedOAuthCallbackContext && !isHostedProjectCallback) {
        return; // Handled by App.tsx hosted OAuth interception
      }
      const errorMessage = errorDescription
        ? `${error}: ${errorDescription}`
        : error;
      const savedHash = localStorage.getItem("mcp-oauth-return-hash") || "";

      toast.error(`OAuth authorization failed: ${errorMessage}`);
      const failedServerName = failPendingOAuthConnection(errorMessage);
      logger.warn("OAuth authorization failed before callback completion", {
        serverName: failedServerName,
        error,
        errorDescription,
      });
      oauthCallbackHandledRef.current = true;
      window.history.replaceState(
        {},
        document.title,
        restorePathAfterOAuthCallback(window.location.pathname, savedHash)
      );
    }
  }, [
    isLoading,
    isAuthLoading,
    isAuthenticated,
    useLocalFallback,
    isLoadingProjects,
    effectiveActiveProjectId,
    failPendingOAuthConnection,
    handleOAuthCallbackComplete,
    logger,
  ]);

  const handleConnect = useCallback(
    async (formData: ServerFormData) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }
      if (notifyIfProjectNotProvisioned()) {
        return;
      }

      const validationError = validateForm(formData);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      const mcpConfig = toMCPConfig(formData);
      dispatch({
        type: "CONNECT_REQUEST",
        name: formData.name,
        config: mcpConfig,
        select: true,
      });
      const token = nextOpToken(formData.name);
      let hostedServerId: string | undefined;
      const existingServerForSave = appState.servers[formData.name];
      const formOAuthProfile = buildOAuthProfileFromFormData(
        formData,
        existingServerForSave?.oauthFlowProfile
      );
      const nextHasClientSecret =
        formData.useOAuth && !formData.clearClientSecret
          ? Boolean(
              formData.clientSecret ||
                formData.hasClientSecret ||
                existingServerForSave?.hasClientSecret
            )
          : false;
      const clientSecretSyncOptions = {
        ...(formData.clientSecret
          ? { clientSecret: formData.clientSecret }
          : {}),
        ...(formData.clearClientSecret ? { clearClientSecret: true } : {}),
      };

      const serverEntryForSave: ServerWithName = {
        name: formData.name,
        config: mcpConfig,
        lastConnectionTime: new Date(),
        connectionStatus: "connecting",
        retryCount: 0,
        enabled: true,
        useOAuth: formData.useOAuth ?? false,
        oauthFlowProfile: formOAuthProfile,
        hasClientSecret: nextHasClientSecret,
      };
      // Both modes: await Convex sync so the returned serverId is available
      // for OAuth binding (hosted) and for the new {projectId, serverId}
      // request shape (local mode resolver path). Failure is non-fatal in
      // local mode — the legacy {serverConfig, serverId: name} body still
      // works as a fallback.
      let syncErr: unknown;
      try {
        const serverId = await syncServerToConvex(
          formData.name,
          serverEntryForSave,
          clientSecretSyncOptions
        );
        if (serverId) {
          hostedServerId = serverId;
          injectHostedServerMapping(formData.name, serverId);
        }
      } catch (err) {
        syncErr = err;
        logger.warn("Sync to Convex failed (pre-connection)", {
          serverName: formData.name,
          err,
        });
      }
      if (HOSTED_MODE && formData.useOAuth && !hostedServerId) {
        // OAuth in hosted mode requires a Convex serverId to bind credentials
        // to; without it the OAuth dance would complete without a durable
        // credential. Local-mode OAuth follows the same constraint post-
        // unification but the legacy localStorage fallback still catches it.
        const errorMessage =
          syncErr instanceof Error
            ? `Could not save the hosted server before starting OAuth: ${syncErr.message}`
            : "Could not save the hosted server before starting OAuth. Please try again.";
        dispatch({
          type: "CONNECT_FAILURE",
          name: formData.name,
          error: errorMessage,
        });
        toast.error(errorMessage);
        return;
      }
      if (!isAuthenticated) {
        const project = appState.projects[appState.activeProjectId];
        if (project) {
          dispatch({
            type: "UPDATE_PROJECT",
            projectId: appState.activeProjectId,
            updates: {
              servers: {
                ...project.servers,
                [formData.name]: serverEntryForSave,
              },
            },
          });
        }
      }

      saveOAuthConfigToLocalStorage(formData);

      try {
        if (formData.type === "http" && formData.useOAuth && formData.url) {
          const existingTokens = getStoredTokens(formData.name);
          if (existingTokens?.access_token) {
            logger.info("Connecting with existing OAuth tokens", {
              serverName: formData.name,
            });
            const serverConfig = {
              url: formData.url,
              requestInit: {
                headers: {
                  Authorization: `Bearer ${existingTokens.access_token}`,
                  ...(formData.headers || {}),
                },
              },
            } satisfies HttpServerConfig;
            const connectionResult = await guardedTestConnection(
              withProjectConnectionDefaults(serverConfig),
              formData.name
            );
            if (isStaleOp(formData.name, token)) return;
            if (connectionResult.success) {
              dispatch({
                type: "CONNECT_SUCCESS",
                name: formData.name,
                config: serverConfig,
                tokens: existingTokens,
                useOAuth: true,
              });
              toast.success(
                "Connected successfully with existing OAuth tokens!"
              );
              storeInitInfo(formData.name, connectionResult.initInfo).catch(
                (err) =>
                  logger.warn("Failed to fetch init info", {
                    serverName: formData.name,
                    err,
                  })
              );
              return;
            }
            logger.warn("Existing tokens failed, will trigger OAuth flow", {
              serverName: formData.name,
              error: connectionResult.error,
            });
          }

          dispatch({
            type: "UPSERT_SERVER",
            name: formData.name,
            server: {
              ...serverEntryForSave,
              connectionStatus: "oauth-flow",
              enabled: true,
              useOAuth: true,
            } as ServerWithName,
          });

          const oauthInputs = await resolveOAuthInitiationInputs(formData);
          const existingOAuthProfile =
            appState.servers[formData.name]?.oauthFlowProfile;
          const protocolMode =
            formData.oauthProtocolMode ??
            existingOAuthProfile?.protocolVersion ??
            "auto";
          const registrationMode =
            formData.oauthRegistrationMode ??
            existingOAuthProfile?.registrationStrategy ??
            "auto";
          const oauthOptions: any = {
            serverName: formData.name,
            serverUrl: formData.url,
            clientId: oauthInputs.clientId,
            clientSecret: oauthInputs.clientSecret,
            hasClientSecret: oauthInputs.hasClientSecret,
            registryServerId: oauthInputs.registryServerId,
            useRegistryOAuthProxy: oauthInputs.useRegistryOAuthProxy,
            customHeaders: mergeWithProjectHeaders(formData.headers),
            protocolMode,
            registrationMode,
            protocolVersion:
              protocolMode !== "auto"
                ? protocolMode
                : existingOAuthProfile?.protocolVersion,
            registrationStrategy:
              registrationMode !== "auto"
                ? registrationMode
                : existingOAuthProfile?.registrationStrategy,
            onTraceUpdate: (oauthTrace: OAuthTrace) => {
              updateServerOAuthTrace(formData.name, oauthTrace);
            },
          };
          if (oauthInputs.scopes && oauthInputs.scopes.length > 0) {
            oauthOptions.scopes = oauthInputs.scopes;
          }
          prepareHostedProjectOAuthRedirect({
            serverId: hostedServerId,
            serverName: formData.name,
            serverUrl: formData.url,
          });
          const oauthResult = await initiateOAuth(oauthOptions);
          if (oauthResult.success) {
            if (oauthResult.serverConfig) {
              const connectionResult = await guardedTestConnection(
                withProjectConnectionDefaults(oauthResult.serverConfig),
                formData.name
              );
              if (isStaleOp(formData.name, token)) return;
              if (connectionResult.success) {
                dispatch({
                  type: "CONNECT_SUCCESS",
                  name: formData.name,
                  config: oauthResult.serverConfig,
                  tokens:
                    HOSTED_MODE && isAuthenticated
                      ? undefined
                      : getStoredTokens(formData.name),
                  useOAuth: true,
                  oauthTrace: oauthResult.oauthTrace,
                });
                toast.success("Connected successfully with OAuth!");
                storeInitInfo(formData.name, connectionResult.initInfo).catch(
                  (err) =>
                    logger.warn("Failed to fetch init info", {
                      serverName: formData.name,
                      err,
                    })
                );
              } else {
                dispatch({
                  type: "CONNECT_FAILURE",
                  name: formData.name,
                  error:
                    connectionResult.error || "OAuth connection test failed",
                  oauthTrace: oauthResult.oauthTrace,
                });
                toast.error(
                  `OAuth succeeded but connection failed: ${connectionResult.error}`
                );
              }
            } else {
              toast.success(
                "OAuth flow initiated. You will be redirected to authorize access."
              );
            }
            return;
          }

          if (isStaleOp(formData.name, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name: formData.name,
            error: oauthResult.error || "OAuth initialization failed",
            oauthTrace: oauthResult.oauthTrace,
          });
          toast.error(`OAuth initialization failed: ${oauthResult.error}`);
          return;
        }

        const hasPendingCallback = new URLSearchParams(
          window.location.search
        ).has("code");
        if (!hasPendingCallback) {
          clearOAuthData(formData.name);
        }
        const effectiveConfig = withProjectConnectionDefaults(mcpConfig);
        const result = await guardedTestConnection(
          effectiveConfig,
          formData.name
        );
        if (isStaleOp(formData.name, token)) return;
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: formData.name,
            config: mcpConfig,
            useOAuth: formData.useOAuth ?? false,
          });
          // Env now persists on the Convex server doc via syncServerToConvex;
          // no localStorage write needed. The resolver returns env in the
          // resolved config on subsequent connects.
          logger.info("Connection successful", { serverName: formData.name });
          if (
            !shouldSuppressExcalidrawConnectToastForOnboarding(formData.name)
          ) {
            toast.success("Connected successfully!");
          }
          storeInitInfo(formData.name, result.initInfo).catch((err) =>
            logger.warn("Failed to fetch init info", {
              serverName: formData.name,
              err,
            })
          );
        } else {
          dispatch({
            type: "CONNECT_FAILURE",
            name: formData.name,
            error: result.error || "Connection test failed",
          });
          logger.error("Connection failed", {
            serverName: formData.name,
            error: result.error,
          });
          toast.error(`Failed to connect to ${formData.name}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(formData.name, token)) return;
        dispatch({
          type: "CONNECT_FAILURE",
          name: formData.name,
          error: errorMessage,
        });
        logger.error("Connection failed", {
          serverName: formData.name,
          error: errorMessage,
        });
        toast.error(
          errorMessage === PROJECT_NOT_PROVISIONED_ERROR_MESSAGE
            ? errorMessage
            : `Network error: ${errorMessage}`
        );
      }
    },
    [
      dispatch,
      isAuthenticated,
      appState.servers,
      appState.projects,
      appState.activeProjectId,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
      prepareHostedProjectOAuthRedirect,
      resolveOAuthInitiationInputs,
      syncServerToConvex,
      logger,
      storeInitInfo,
      guardedTestConnection,
      updateServerOAuthTrace,
      withProjectConnectionDefaults,
    ]
  );

  const saveServerConfigWithoutConnecting = useCallback(
    async (
      formData: ServerFormData,
      options?: { oauthProfile?: OAuthTestProfile }
    ) => {
      const validationError = validateForm(formData);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      const serverName = formData.name.trim();
      if (!serverName) {
        toast.error("Server name is required");
        return;
      }

      const existingServer = appState.servers[serverName];
      const mcpConfig = toMCPConfig(formData);
      const nextOAuthProfile = formData.useOAuth
        ? options?.oauthProfile ??
          buildOAuthProfileFromFormData(
            formData,
            existingServer?.oauthFlowProfile
          ) ??
          existingServer?.oauthFlowProfile
        : undefined;
      const nextHasClientSecret =
        formData.useOAuth && !formData.clearClientSecret
          ? Boolean(
              formData.clientSecret ||
                formData.hasClientSecret ||
                existingServer?.hasClientSecret
            )
          : false;

      const serverEntry: ServerWithName = {
        ...(existingServer ?? {}),
        name: serverName,
        config: mcpConfig,
        lastConnectionTime: existingServer?.lastConnectionTime ?? new Date(),
        connectionStatus: "disconnected",
        retryCount: existingServer?.retryCount ?? 0,
        enabled: existingServer?.enabled ?? false,
        oauthFlowProfile: nextOAuthProfile,
        useOAuth: formData.useOAuth ?? false,
        hasClientSecret: nextHasClientSecret,
      } as ServerWithName;

      const hasPendingOAuthCallback = new URLSearchParams(
        window.location.search
      ).has("code");
      if (!formData.useOAuth && !hasPendingOAuthCallback) {
        clearOAuthData(serverName);
      }

      dispatch({
        type: "UPSERT_SERVER",
        name: serverName,
        server: serverEntry,
      });

      saveOAuthConfigToLocalStorage(formData);

      if (
        isAuthenticated &&
        !useLocalFallback &&
        effectiveActiveProjectId &&
        effectiveActiveProjectId !== "none"
      ) {
        try {
          await syncServerToConvex(serverName, serverEntry, {
            ...(formData.clientSecret
              ? { clientSecret: formData.clientSecret }
              : {}),
            ...(formData.clearClientSecret ? { clearClientSecret: true } : {}),
          });
        } catch (error) {
          logger.error("Failed to sync server to Convex", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } else {
        persistServerToLocalProject(serverName, serverEntry);
      }

      logger.info("Saved server configuration without connecting", {
        serverName,
      });
      toast.success(`Saved configuration for ${serverName}`);
    },
    [
      appState.activeProjectId,
      appState.servers,
      appState.projects,
      logger,
      dispatch,
      isAuthenticated,
      useLocalFallback,
      effectiveActiveProjectId,
      syncServerToConvex,
      persistServerToLocalProject,
    ]
  );

  const applyTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
      },
      serverUrl: string
    ): Promise<{ success: boolean; error?: string }> => {
      const tokenData = {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType || "Bearer",
        expires_in: tokens.expiresIn,
      };
      if (!HOSTED_MODE) {
        localStorage.setItem(
          `mcp-tokens-${serverName}`,
          JSON.stringify(tokenData)
        );
      }

      if (!HOSTED_MODE && tokens.clientId) {
        localStorage.setItem(
          `mcp-client-${serverName}`,
          JSON.stringify({
            client_id: tokens.clientId,
            client_secret: tokens.clientSecret,
          })
        );
      }

      if (!HOSTED_MODE) {
        localStorage.setItem(`mcp-serverUrl-${serverName}`, serverUrl);
      }

      const serverConfig = {
        url: serverUrl,
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        },
      } satisfies HttpServerConfig;

      dispatch({
        type: "CONNECT_REQUEST",
        name: serverName,
        config: serverConfig,
        select: true,
      });

      const token = nextOpToken(serverName);

      try {
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(serverConfig)
        );
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: serverConfig,
            tokens: getStoredTokens(serverName),
            useOAuth: true,
          });
          await storeInitInfo(serverName, result.initInfo);
          return { success: true };
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: result.error || "Connection failed",
        });
        return { success: false, error: result.error };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        return { success: false, error: errorMessage };
      }
    },
    [
      dispatch,
      storeInitInfo,
      guardedReconnectServer,
      withProjectConnectionDefaults,
    ]
  );

  const handleConnectWithTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
      },
      serverUrl: string
    ) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }
      if (notifyIfProjectNotProvisioned()) {
        return;
      }

      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl
      );
      if (result.success) {
        toast.success(`Connected to ${serverName}!`);
      } else {
        toast.error(`Connection failed: ${result.error}`);
      }
    },
    [
      applyTokensFromOAuthFlow,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
    ]
  );

  const handleRefreshTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
      },
      serverUrl: string
    ) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }
      if (notifyIfProjectNotProvisioned()) {
        return;
      }

      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl
      );
      if (result.success) {
        toast.success(`Tokens refreshed for ${serverName}!`);
      } else {
        toast.error(`Token refresh failed: ${result.error}`);
      }
    },
    [
      applyTokensFromOAuthFlow,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
    ]
  );

  const cliConfigProcessedRef = useRef<boolean>(false);

  useEffect(() => {
    if (HOSTED_MODE) {
      return;
    }

    if (!isLoading && !cliConfigProcessedRef.current) {
      cliConfigProcessedRef.current = true;
      authFetch("/api/mcp-cli-config")
        .then((response) => response.json())
        .then((data) => {
          const cliConfig = data.config;
          if (cliConfig) {
            if (cliConfig.initialTab && !window.location.hash) {
              window.location.hash = cliConfig.initialTab;
            }

            if (
              cliConfig.cspMode === "permissive" ||
              cliConfig.cspMode === "widget-declared"
            ) {
              const store = useUIPlaygroundStore.getState();
              store.setCspMode(cliConfig.cspMode);
              store.setMcpAppsCspMode(cliConfig.cspMode);
            }

            if (cliConfig.servers && Array.isArray(cliConfig.servers)) {
              const autoConnectServer = cliConfig.autoConnectServer;

              logger.info(
                "Processing CLI-provided MCP servers (from config file)",
                {
                  serverCount: cliConfig.servers.length,
                  autoConnectServer: autoConnectServer || "all",
                  cliConfig: cliConfig,
                }
              );

              cliConfig.servers.forEach((server: any) => {
                const serverName = server.name || "CLI Server";
                const urlParams = new URLSearchParams(window.location.search);
                const oauthCallbackInProgress = urlParams.has("code");
                const formData: ServerFormData = {
                  name: serverName,
                  type: (server.type === "sse"
                    ? "http"
                    : server.type || "stdio") as "stdio" | "http",
                  command: server.command,
                  args: server.args || [],
                  url: server.url,
                  env: server.env || {},
                  headers: server.headers,
                  useOAuth: server.useOAuth ?? false,
                };

                const mcpConfig = toMCPConfig(formData);
                dispatch({
                  type: "UPSERT_SERVER",
                  name: formData.name,
                  server: {
                    name: formData.name,
                    config: mcpConfig,
                    lastConnectionTime: new Date(),
                    connectionStatus: "disconnected" as const,
                    retryCount: 0,
                    enabled: false,
                  },
                });

                if (oauthCallbackInProgress && server.useOAuth) {
                  logger.info("Skipping auto-connect for OAuth server", {
                    serverName: server.name,
                    reason: "OAuth callback in progress",
                  });
                } else if (
                  !autoConnectServer ||
                  server.name === autoConnectServer
                ) {
                  logger.info("Auto-connecting to server", {
                    serverName: server.name,
                  });
                  handleConnect(formData);
                } else {
                  logger.info("Skipping auto-connect for server", {
                    serverName: server.name,
                    reason: "filtered out",
                  });
                }
              });
              return;
            }
            if (cliConfig.command) {
              logger.info("Auto-connecting to CLI-provided MCP server", {
                cliConfig,
              });
              const formData: ServerFormData = {
                name: cliConfig.name || "CLI Server",
                type: "stdio" as const,
                command: cliConfig.command,
                args: cliConfig.args || [],
                env: cliConfig.env || {},
              };
              handleConnect(formData);
            }
          }
        })
        .catch((error) => {
          logger.debug("Could not fetch CLI config from API", { error });
        });
    }
  }, [isLoading, handleConnect, logger, dispatch]);

  const getValidAccessToken = useCallback(
    async (serverName: string): Promise<string | null> => {
      const server = appState.servers[serverName];
      if (!server?.oauthTokens) return null;
      return server.oauthTokens.access_token || null;
    },
    [appState.servers]
  );

  const handleDisconnect = useCallback(
    async (serverName: string) => {
      logger.info("Disconnecting from server", { serverName });
      dispatch({ type: "DISCONNECT", name: serverName });
      try {
        const result = await deleteServer(serverName);
        if (!result.success) {
          dispatch({
            type: "DISCONNECT",
            name: serverName,
            error: result.error,
          });
        }
      } catch (error) {
        dispatch({
          type: "DISCONNECT",
          name: serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [dispatch, logger]
  );

  const cleanupServerLocalArtifacts = useCallback((serverName: string) => {
    // Slice 5: env removal handled by Convex deleteServer; only OAuth local
    // scratchpad remains and is cleaned up here. Once Slice 2's OAuth purge
    // collapses the localStorage cache fully, this can drop too.
    clearOAuthData(serverName);
    // Env now lives on the Convex server doc; removal happens via the
    // server-delete mutation. No localStorage cleanup needed.
  }, []);

  const removeServerFromStateAndCloud = useCallback(
    async (serverName: string) => {
      cleanupServerLocalArtifacts(serverName);
      dispatch({ type: "REMOVE_SERVER", name: serverName });
      await removeServerFromConvex(serverName);
    },
    [cleanupServerLocalArtifacts, dispatch, removeServerFromConvex]
  );

  const handleRemoveServer = useCallback(
    async (serverName: string) => {
      logger.info("Removing server", { serverName });
      await handleDisconnect(serverName);
      await removeServerFromStateAndCloud(serverName);
    },
    [logger, handleDisconnect, removeServerFromStateAndCloud]
  );

  const waitForServerReconnectOutcome = useCallback(
    async (
      serverName: string,
      timeoutMs = 15_000
    ): Promise<EnsureServerConnectionResult> =>
      await new Promise<EnsureServerConnectionResult>((resolve) => {
        const startedAt = Date.now();

        const check = () => {
          const server = latestEffectiveServersRef.current[serverName];
          if (!server) {
            resolve({
              status: "missing",
              error: `Server ${serverName} not found`,
            });
            return;
          }

          if (server.connectionStatus === "connected") {
            resolve({ status: "connected" });
            return;
          }

          if (server.connectionStatus === "oauth-flow") {
            resolve({
              status: "reauth",
              error: `Reauthenticate ${serverName} to continue.`,
            });
            return;
          }

          if (
            server.connectionStatus === "failed" ||
            (server.connectionStatus === "disconnected" &&
              Date.now() - startedAt > 250)
          ) {
            resolve({
              status: "failed",
              error: server.lastError || `Failed to reconnect to ${serverName}`,
            });
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            resolve({
              status: "failed",
              error: `Timed out reconnecting to ${serverName}`,
            });
            return;
          }

          window.setTimeout(check, 100);
        };

        check();
      }),
    []
  );

  const reconnectServerInternal = useCallback(
    async (
      serverName: string,
      options?: ReconnectServerInternalOptions
    ): Promise<EnsureServerConnectionResult> => {
      const select = options?.select ?? true;
      const suppressErrors = options?.suppressErrors ?? false;

      const reportError = (errorMessage: string) => {
        if (!suppressErrors) {
          toast.error(errorMessage);
        }
      };

      if (isClientConfigSyncPending) {
        const errorMessage = CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE;
        reportError(errorMessage);
        return {
          status: "failed",
          error: errorMessage,
        };
      }

      const projectNotProvisionedError = getProjectNotProvisionedError();
      if (projectNotProvisionedError) {
        reportError(projectNotProvisionedError);
        return {
          status: "failed",
          error: projectNotProvisionedError,
        };
      }

      // Defer reconnects until bootstrap completes. Without this, the
      // page-load auto-reconnect loop fires before the project + server
      // mappings are loaded, hits validate without {projectId, serverId},
      // and produces "Hosted server metadata is still syncing" toasts.
      // Returning `failed` (not throwing) lets ensureServersReady move on
      // and a later trigger (project resolves, user clicks reconnect)
      // can retry against a ready app.
      if (HOSTED_MODE) {
        const projectIdForReconnect = effectiveActiveProjectIdRef.current;
        if (
          !projectIdForReconnect ||
          projectIdForReconnect === "none"
        ) {
          logger.info("Deferring reconnect: app still bootstrapping", {
            serverName,
          });
          return {
            status: "failed",
            error: "App is still loading. Reconnect will retry once ready.",
          };
        }
      }

      logger.info("Reconnecting to server", { serverName, options });
      const server = latestEffectiveServersRef.current[serverName];
      if (!server) {
        const errorMessage = `Server ${serverName} not found`;
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        logger.error("Reconnection failed", {
          serverName,
          error: errorMessage,
        });
        reportError(errorMessage);
        return {
          status: "missing",
          error: errorMessage,
        };
      }

      dispatch({
        type: "RECONNECT_REQUEST",
        name: serverName,
        config: server.config,
        select,
      });
      const token = nextOpToken(serverName);
      const hostedProjectServerId = activeProjectServersFlat?.find(
        (remoteServer) => remoteServer.name === serverName
      )?._id;

      if (options?.forceOAuthFlow) {
        const serverUrl = (server.config as any)?.url?.toString?.();
        if (!serverUrl) {
          const errorMessage = "No server URL found for OAuth flow";
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
          });
          reportError(errorMessage);
          return {
            status: "failed",
            error: errorMessage,
          };
        }

        const storedOAuthConfig = readStoredOAuthConfig(serverName);
        const storedClientCredentials = readStoredClientCredentials(serverName);
        const profileScopes = parseOAuthScopes(server.oauthFlowProfile?.scopes);
        const profileHeaders = profileHeadersToRecord(
          server.oauthFlowProfile?.customHeaders
        );
        const protocolMode =
          server.oauthFlowProfile?.protocolVersion ??
          storedOAuthConfig.protocolMode ??
          "auto";
        const registrationMode =
          server.oauthFlowProfile?.registrationStrategy ??
          storedOAuthConfig.registrationMode ??
          "auto";
        const oauthOptions = {
          serverName,
          serverUrl,
          scopes: profileScopes ?? storedOAuthConfig.scopes,
          resourceUrl:
            server.oauthFlowProfile?.resourceUrl ??
            storedOAuthConfig.resourceUrl,
          clientId:
            server.oauthTokens?.client_id ??
            server.oauthFlowProfile?.clientId ??
            storedClientCredentials.clientId,
          clientSecret:
            server.oauthTokens?.client_secret ??
            server.oauthFlowProfile?.clientSecret ??
            storedClientCredentials.clientSecret,
          hasClientSecret: Boolean(
            server.oauthTokens?.client_secret ||
              server.oauthFlowProfile?.clientSecret ||
              storedClientCredentials.clientSecret ||
              server.hasClientSecret
          ),
          customHeaders: mergeWithProjectHeaders(
            profileHeaders ??
              ("requestInit" in server.config
                ? extractRequestHeaders(server.config.requestInit)
                : undefined) ??
              storedOAuthConfig.customHeaders
          ),
          registryServerId: storedOAuthConfig.registryServerId,
          useRegistryOAuthProxy: storedOAuthConfig.useRegistryOAuthProxy,
          protocolMode,
          registrationMode,
          protocolVersion:
            protocolMode !== "auto"
              ? protocolMode
              : server.oauthFlowProfile?.protocolVersion ??
                storedOAuthConfig.protocolVersion,
          registrationStrategy:
            registrationMode !== "auto"
              ? registrationMode
              : server.oauthFlowProfile?.registrationStrategy ??
                storedOAuthConfig.registrationStrategy,
          onTraceUpdate: (oauthTrace: OAuthTrace) => {
            updateServerOAuthTrace(serverName, oauthTrace);
          },
        };

        clearOAuthData(serverName);
        dispatch({
          type: "UPSERT_SERVER",
          name: serverName,
          server: {
            ...server,
            connectionStatus: "oauth-flow",
            enabled: true,
            lastError: undefined,
            useOAuth: true,
          },
        });
        let oauthResult: Awaited<ReturnType<typeof initiateOAuth>>;
        try {
          await deleteServer(serverName);

          prepareHostedProjectOAuthRedirect({
            serverId: hostedProjectServerId,
            serverName,
            serverUrl,
          });
          oauthResult = await initiateOAuth(oauthOptions);
        } catch (error) {
          if (isStaleOp(serverName, token)) {
            return {
              status: "failed",
              error:
                error instanceof Error ? error.message : "OAuth flow failed",
            };
          }
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to start OAuth flow";
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
          });
          reportError(errorMessage);
          return {
            status: "failed",
            error: errorMessage,
          };
        }

        if (oauthResult.success && !oauthResult.serverConfig) {
          return {
            status: "reauth",
            error: `Reauthenticate ${serverName} to continue.`,
          };
        }
        if (!oauthResult.success) {
          if (isStaleOp(serverName, token)) {
            return {
              status: "failed",
              error: oauthResult.error || "OAuth flow failed",
            };
          }
          const errorMessage = oauthResult.error || "OAuth flow failed";
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
            oauthTrace: oauthResult.oauthTrace,
          });
          reportError(`OAuth failed: ${serverName}`);
          return {
            status: "failed",
            error: errorMessage,
          };
        }
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(oauthResult.serverConfig!)
        );
        if (isStaleOp(serverName, token)) {
          return {
            status: "failed",
            error: result.error || "Reconnection failed after OAuth",
          };
        }
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: oauthResult.serverConfig!,
            tokens:
              HOSTED_MODE && isAuthenticated
                ? undefined
                : getStoredTokens(serverName),
            useOAuth: true,
            oauthTrace: oauthResult.oauthTrace,
          });
          logger.info("Reconnection with fresh OAuth successful", {
            serverName,
          });
          storeInitInfo(serverName, result.initInfo).catch((err) =>
            logger.warn("Failed to fetch init info", { serverName, err })
          );
          return { status: "connected" };
        }
        const errorMessage = result.error || "Reconnection failed after OAuth";
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
          oauthTrace: oauthResult.oauthTrace,
        });
        reportError(errorMessage);
        return {
          status: "failed",
          error: errorMessage,
        };
      }

      if (HOSTED_MODE && isAuthenticated && server.useOAuth === true) {
        const hostedReconnectConfig = withProjectConnectionDefaults(
          server.config
        );
        try {
          const result = await guardedReconnectServer(
            serverName,
            hostedReconnectConfig
          );
          if (isStaleOp(serverName, token)) {
            return {
              status: "failed",
              error: result.error || "Reconnection failed",
            };
          }
          if (result.success) {
            dispatch({
              type: "CONNECT_SUCCESS",
              name: serverName,
              config: server.config,
              tokens: undefined,
              useOAuth: true,
            });
            logger.info("Hosted reconnect successful using stored OAuth", {
              serverName,
              result,
            });
            storeInitInfo(serverName, result.initInfo).catch((err) =>
              logger.warn("Failed to fetch init info", { serverName, err })
            );
            return { status: "connected" };
          }

          if (!requiresFreshOAuthAuthorization(result.error)) {
            const errorMessage = result.error || "Reconnection failed";
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: errorMessage,
            });
            logger.error("Hosted reconnect failed", { serverName, result });
            reportError(errorMessage || `Failed to reconnect: ${serverName}`);
            return {
              status: "failed",
              error: errorMessage,
            };
          }

          logger.info(
            "Hosted reconnect requires a fresh OAuth flow after stored credential lookup",
            { serverName, error: result.error }
          );
        } catch (error) {
          if (isStaleOp(serverName, token)) {
            return {
              status: "failed",
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }

          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";

          if (!requiresFreshOAuthAuthorization(error)) {
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: errorMessage,
            });
            logger.error("Hosted reconnect failed", {
              serverName,
              error: errorMessage,
            });
            reportError(errorMessage || `Failed to reconnect: ${serverName}`);
            return {
              status: "failed",
              error: errorMessage,
            };
          }

          logger.info(
            "Hosted reconnect requires a fresh OAuth flow after stored credential lookup",
            { serverName, error: errorMessage }
          );
        }
      }

      try {
        const authResult: OAuthResult = await ensureAuthorizedForReconnect(
          server,
          {
            beforeRedirect: (oauthOptions) => {
              prepareHostedProjectOAuthRedirect({
                serverId: hostedProjectServerId,
                serverName,
                serverUrl: oauthOptions.serverUrl,
              });
            },
            onTraceUpdate: (oauthTrace: OAuthTrace) => {
              updateServerOAuthTrace(serverName, oauthTrace);
            },
            allowInteractiveOAuthFlow: options?.allowInteractiveOAuthFlow,
          }
        );
        if (authResult.kind === "redirect") {
          return {
            status: "reauth",
            error: `Reauthenticate ${serverName} to continue.`,
          };
        }
        if (authResult.kind === "reauth_required") {
          if (isStaleOp(serverName, token)) {
            return {
              status: "reauth",
              error: authResult.error,
            };
          }
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: authResult.error,
            oauthTrace: authResult.oauthTrace,
          });
          reportError(authResult.error);
          return {
            status: "reauth",
            error: authResult.error,
          };
        }
        if (authResult.kind === "error") {
          if (isStaleOp(serverName, token)) {
            return {
              status: "failed",
              error: authResult.error,
            };
          }
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: authResult.error,
            oauthTrace: authResult.oauthTrace,
          });
          reportError(`Failed to connect: ${serverName}`);
          return {
            status: "failed",
            error: authResult.error,
          };
        }
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(authResult.serverConfig)
        );
        if (isStaleOp(serverName, token)) {
          return {
            status: "failed",
            error: result.error || "Reconnection failed",
          };
        }
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: authResult.serverConfig,
            tokens: authResult.tokens,
            useOAuth: server.useOAuth === true || authResult.tokens != null,
            oauthTrace: authResult.oauthTrace,
          });
          logger.info("Reconnection successful", { serverName, result });
          storeInitInfo(serverName, result.initInfo).catch((err) =>
            logger.warn("Failed to fetch init info", { serverName, err })
          );
          return { status: "connected" };
        }
        const errorMessage = result.error || "Reconnection failed";
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
          oauthTrace: authResult.oauthTrace,
        });
        logger.error("Reconnection failed", { serverName, result });
        reportError(errorMessage || `Failed to reconnect: ${serverName}`);
        return {
          status: "failed",
          error: errorMessage,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(serverName, token)) {
          return {
            status: "failed",
            error: errorMessage,
          };
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        logger.error("Reconnection failed", {
          serverName,
          error: errorMessage,
        });
        reportError(errorMessage);
        return {
          status: "failed",
          error: errorMessage,
        };
      }
    },
    [
      activeProjectServersFlat,
      isAuthenticated,
      isClientConfigSyncPending,
      getProjectNotProvisionedError,
      storeInitInfo,
      logger,
      dispatch,
      prepareHostedProjectOAuthRedirect,
      guardedReconnectServer,
      mergeWithProjectHeaders,
      updateServerOAuthTrace,
      withProjectConnectionDefaults,
    ]
  );

  const handleReconnect = useCallback(
    async (
      serverName: string,
      options?: {
        forceOAuthFlow?: boolean;
        allowInteractiveOAuthFlow?: boolean;
      }
    ) => {
      await reconnectServerInternal(serverName, {
        forceOAuthFlow: options?.forceOAuthFlow,
        allowInteractiveOAuthFlow: options?.allowInteractiveOAuthFlow ?? true,
        select: true,
      });
    },
    [reconnectServerInternal]
  );

  const ensureServersReady = useCallback(
    async (serverNames: string[]): Promise<EnsureServersReadyResult> => {
      const uniqueServerNames = [...new Set(serverNames.filter(Boolean))];

      const resolveToProjectServerKey = (serverRef: string): string => {
        const effective = latestEffectiveServersRef.current;
        if (effective[serverRef]) {
          return serverRef;
        }

        const fromProject = activeProjectServersFlat?.find(
          (s) => s._id === serverRef
        );
        if (fromProject) {
          return fromProject.name;
        }

        if (HOSTED_MODE) {
          const hosted = tryGetHostedServerDisplayName(serverRef);
          if (hosted && effective[hosted]) {
            return hosted;
          }
        }

        return serverRef;
      };

      // Multiple refs (e.g. hosted id and display name) can collapse to the
      // same project server. Group by resolved key so we only kick off one
      // reconnect per real server and avoid spurious "stale op" failures.
      type RefGroup = { resolvedKey: string; refs: string[] };
      const groupsByKey = new Map<string, RefGroup>();
      const orderedKeys: string[] = [];
      for (const serverName of uniqueServerNames) {
        const resolvedKey = resolveToProjectServerKey(serverName);
        const existing = groupsByKey.get(resolvedKey);
        if (existing) {
          existing.refs.push(serverName);
        } else {
          groupsByKey.set(resolvedKey, { resolvedKey, refs: [serverName] });
          orderedKeys.push(resolvedKey);
        }
      }

      const outcomesByKey = await Promise.all(
        orderedKeys.map(
          async (
            resolvedKey
          ): Promise<readonly [string, EnsureServerConnectionResult]> => {
            const server = latestEffectiveServersRef.current[resolvedKey];
            if (!server) {
              return [
                resolvedKey,
                {
                  status: "missing",
                  error: `Server ${resolvedKey} not found`,
                },
              ] as const;
            }

            if (server.connectionStatus === "connected") {
              return [resolvedKey, { status: "connected" }] as const;
            }

            if (server.connectionStatus === "connecting") {
              return [
                resolvedKey,
                await waitForServerReconnectOutcome(resolvedKey),
              ] as const;
            }

            if (server.connectionStatus === "oauth-flow") {
              return [
                resolvedKey,
                {
                  status: "reauth",
                  error: `Reauthenticate ${resolvedKey} to continue.`,
                },
              ] as const;
            }

            return [
              resolvedKey,
              await reconnectServerInternal(resolvedKey, {
                allowInteractiveOAuthFlow: false,
                select: false,
                suppressErrors: true,
              }),
            ] as const;
          }
        )
      );

      const outcomeByKey = new Map(outcomesByKey);
      const outcomes: ReadonlyArray<
        readonly [string, EnsureServerConnectionResult]
      > = uniqueServerNames.map((serverName) => {
        const resolvedKey = resolveToProjectServerKey(serverName);
        const outcome = outcomeByKey.get(resolvedKey) ?? {
          status: "missing",
          error: `Server ${serverName} not found`,
        };
        return [serverName, outcome] as const;
      });

      const readyServerNames: string[] = [];
      const missingServerNames: string[] = [];
      const failedServerNames: string[] = [];
      const reauthServerNames: string[] = [];

      for (const [serverName, outcome] of outcomes) {
        switch (outcome.status) {
          case "connected":
            readyServerNames.push(serverName);
            break;
          case "missing":
            missingServerNames.push(serverName);
            break;
          case "reauth":
            reauthServerNames.push(serverName);
            break;
          case "failed":
          default:
            failedServerNames.push(serverName);
            break;
        }
      }

      return {
        readyServerNames,
        missingServerNames,
        failedServerNames,
        reauthServerNames,
      };
    },
    [
      activeProjectServersFlat,
      reconnectServerInternal,
      waitForServerReconnectOutcome,
    ]
  );

  const syncAgentStatus = useCallback(async () => {
    try {
      const result = await listServers();
      if (result?.success && Array.isArray(result.servers)) {
        dispatch({ type: "SYNC_AGENT_STATUS", servers: result.servers });
      }
      return result;
    } catch (error) {
      logger.debug("Failed to sync server status", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }, [logger, dispatch]);

  useEffect(() => {
    if (isLoading) return;
    void syncAgentStatus().catch((error) => {
      logger.debug("Startup server status sync failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    });
  }, [isLoading, logger, syncAgentStatus]);

  const setSelectedServer = useCallback(
    (serverName: string) => {
      dispatch({ type: "SELECT_SERVER", name: serverName });
    },
    [dispatch]
  );

  const setSelectedMCPConfigs = useCallback(
    (serverNames: string[]) => {
      dispatch({ type: "SET_MULTI_SELECTED", names: serverNames });
    },
    [dispatch]
  );

  const toggleMultiSelectMode = useCallback(
    (enabled: boolean) => {
      dispatch({ type: "SET_MULTI_MODE", enabled });
    },
    [dispatch]
  );

  const toggleServerSelection = useCallback(
    (serverName: string) => {
      const current = appState.selectedMultipleServers;
      const next = current.includes(serverName)
        ? current.filter((n) => n !== serverName)
        : [...current, serverName];
      dispatch({ type: "SET_MULTI_SELECTED", names: next });
    },
    [appState.selectedMultipleServers, dispatch]
  );

  const handleUpdate = useCallback(
    async (
      originalServerName: string,
      formData: ServerFormData,
      skipAutoConnect?: boolean
    ): Promise<ServerUpdateResult> => {
      const nextServerName = formData.name.trim();
      if (!nextServerName) {
        toast.error("Server name is required");
        return { ok: false, serverName: originalServerName };
      }
      const isRename = nextServerName !== originalServerName;
      const activeProjectServers =
        effectiveProjects[effectiveActiveProjectId]?.servers ?? {};
      if (isRename && activeProjectServers[nextServerName]) {
        toast.error(
          `A server named "${nextServerName}" already exists. Choose a different name.`
        );
        return { ok: false, serverName: originalServerName };
      }
      const originalServer =
        appState.servers[originalServerName] ??
        effectiveServers[originalServerName];

      if (skipAutoConnect) {
        const mcpConfig = toMCPConfig(formData);
        if (isRename) {
          await handleDisconnect(originalServerName);
          await removeServerFromStateAndCloud(originalServerName);
        }

        const updatedServer: ServerWithName = {
          ...(originalServer ?? {}),
          name: nextServerName,
          config: mcpConfig,
          lastConnectionTime: originalServer?.lastConnectionTime ?? new Date(),
          connectionStatus: originalServer?.connectionStatus ?? "disconnected",
          retryCount: originalServer?.retryCount ?? 0,
          enabled: originalServer?.enabled ?? false,
          oauthTokens: originalServer?.oauthTokens,
          oauthFlowProfile: originalServer?.oauthFlowProfile,
          initializationInfo: originalServer?.initializationInfo,
          useOAuth: formData.useOAuth ?? false,
        } as ServerWithName;

        if (!formData.useOAuth) {
          clearOAuthData(nextServerName);
        }
        dispatch({
          type: "UPSERT_SERVER",
          name: nextServerName,
          server: updatedServer,
        });

        if (!isAuthenticated || useLocalFallback) {
          persistServerToLocalProject(nextServerName, updatedServer, {
            originalServerName: isRename ? originalServerName : undefined,
          });
        } else {
          await syncServerToConvex(nextServerName, updatedServer);
        }

        saveOAuthConfigToLocalStorage(formData);
        if (appState.selectedServer === originalServerName && isRename) {
          setSelectedServer(nextServerName);
        }
        toast.success("Server configuration updated");
        return { ok: true, serverName: nextServerName };
      }

      const hadOAuthTokens = originalServer?.oauthTokens != null;
      if (notifyIfClientConfigSyncPending()) {
        return { ok: false, serverName: originalServerName };
      }
      if (notifyIfProjectNotProvisioned()) {
        return { ok: false, serverName: originalServerName };
      }

      const shouldPreserveOAuth =
        hadOAuthTokens &&
        formData.useOAuth &&
        nextServerName === originalServerName &&
        formData.type === "http" &&
        formData.url === (originalServer?.config as any).url?.toString();

      if (shouldPreserveOAuth && originalServer) {
        const mcpConfig = toMCPConfig(formData);
        dispatch({
          type: "CONNECT_REQUEST",
          name: originalServerName,
          config: mcpConfig,
        });
        saveOAuthConfigToLocalStorage(formData);
        try {
          const result = await guardedTestConnection(
            withProjectConnectionDefaults(originalServer.config),
            originalServerName
          );
          if (result.success) {
            dispatch({
              type: "CONNECT_SUCCESS",
              name: originalServerName,
              config: mcpConfig,
              useOAuth: true,
            });
            await storeInitInfo(originalServerName, result.initInfo);
            toast.success("Server configuration updated successfully!");
            return { ok: true, serverName: originalServerName };
          }
          console.warn(
            "OAuth connection test failed, falling back to full reconnect"
          );
        } catch (error) {
          console.warn(
            "OAuth connection test error, falling back to full reconnect",
            error
          );
        }
      }

      if (hadOAuthTokens && !formData.useOAuth) {
        clearOAuthData(originalServerName);
      }

      saveOAuthConfigToLocalStorage(formData);

      if (isRename) {
        await handleDisconnect(originalServerName);
        await removeServerFromStateAndCloud(originalServerName);
      } else {
        await handleDisconnect(originalServerName);
      }
      await handleConnect(formData);
      if (
        appState.selectedServer === originalServerName &&
        nextServerName !== originalServerName
      ) {
        setSelectedServer(nextServerName);
      }
      return { ok: true, serverName: nextServerName };
    },
    [
      appState.servers,
      appState.activeProjectId,
      appState.projects,
      appState.selectedServer,
      dispatch,
      effectiveProjects,
      effectiveActiveProjectId,
      effectiveServers,
      storeInitInfo,
      handleDisconnect,
      handleConnect,
      isAuthenticated,
      removeServerFromStateAndCloud,
      setSelectedServer,
      syncServerToConvex,
      useLocalFallback,
      persistServerToLocalProject,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
      guardedTestConnection,
    ]
  );

  return {
    activeProject,
    effectiveServers,
    projectServers: effectiveServers,
    connectedOrConnectingServerConfigs,
    selectedServerEntry: effectiveServers[appState.selectedServer],
    selectedMCPConfig: effectiveServers[appState.selectedServer]?.config,
    selectedMCPConfigs: appState.selectedMultipleServers
      .map((name) => effectiveServers[name])
      .filter(Boolean),
    selectedMCPConfigsMap: appState.selectedMultipleServers.reduce(
      (acc, name) => {
        if (effectiveServers[name]) {
          acc[name] = effectiveServers[name].config;
        }
        return acc;
      },
      {} as Record<string, MCPServerConfig>
    ),
    isMultiSelectMode: appState.isMultiSelectMode,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    ensureServersReady,
    syncAgentStatus,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    setSelectedMCPConfigs,
    toggleMultiSelectMode,
    toggleServerSelection,
    getValidAccessToken,
    setSelectedMultipleServersToAllServers,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,
    persistRuntimeServerToProjectIfNeeded,
  };
}
