import { useCallback, useEffect, useMemo, useRef, type Dispatch } from "react";
import { useConvex } from "convex/react";
import { toast } from "@/lib/toast";
import type {
  HttpServerConfig,
  MCPServerConfig,
  NormalizedError,
} from "@mcpjam/sdk/browser";
import { isKnownProtocolVersion } from "@mcpjam/sdk/browser";
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
  clearOAuthData,
  initiateOAuth,
  isElectronMcpCallbackState,
  readStoredOAuthConfig,
} from "@/lib/oauth/mcp-oauth";
import {
  importHostedOAuthTokens,
  normalizeImportHostedOAuthTokens,
} from "@/lib/apis/hosted-oauth-import-tokens-api";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";
import {
  clearHostedOAuthPendingState,
  getHostedOAuthCallbackContext,
  writeHostedOAuthPendingMarker,
} from "@/lib/hosted-oauth-callback";
import { HOSTED_MODE } from "@/lib/config";
import { validateServerFormData } from "@/lib/server-form-validation";
import {
  injectHostedServerMapping,
  tryGetHostedServerDisplayName,
  tryResolveProjectServer,
} from "@/lib/apis/web/context";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import { authFetch } from "@/lib/session-token";
import {
  captureCurrentReturnPath,
  navigateApp,
  normalizeReturnTargetPath,
  routePaths,
} from "@/lib/app-navigation";
import { useProjectClientConfigSyncPending } from "./use-project-client-config-sync-pending";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useServerMutations, type RemoteServer } from "./useProjects";
import { writeCliSignInReturnPath } from "@/lib/cli-signin-return-path";
import {
  CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
  PROJECT_NOT_PROVISIONED_ERROR_MESSAGE,
  getEffectiveProjectConnectionDefaults,
  mergeProjectConnectionHeaders,
} from "@/lib/client-config";
import { resolveEffectiveClientCapabilities } from "@/lib/effective-client";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import { readOnboardingState } from "@/lib/onboarding-state";
import {
  resolveEffectiveMcpProtocolVersion,
  type HostConfigDtoV2,
  type McpProtocolVersion,
} from "@/lib/client-config-v2";
import { resolveServerConnectionSettings } from "@/lib/client-connection-resolve";
import { useDbUserReady } from "@/contexts/db-user-ready-context";

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
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string"
      )
    );
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
    ...(omitAuthorizationHeader(
      extractRequestHeaders(callbackConfig.requestInit)
    ) ?? {}),
  };
  const nextRequestInit =
    existingHttpConfig?.requestInit || callbackConfig.requestInit
      ? {
          ...(existingHttpConfig?.requestInit ?? {}),
          ...(callbackConfig.requestInit ?? {}),
        }
      : undefined;
  if (nextRequestInit) {
    if (Object.keys(mergedHeaders).length > 0) {
      nextRequestInit.headers = mergedHeaders;
    } else {
      delete nextRequestInit.headers;
    }
  }

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
  } as HttpServerConfig;
}

function stripAuthorizationFromHttpConfig(
  config: HttpServerConfig
): HttpServerConfig {
  const headers = omitAuthorizationHeader(
    extractRequestHeaders(config.requestInit)
  );
  const requestInit = config.requestInit
    ? {
        ...config.requestInit,
      }
    : undefined;
  if (requestInit) {
    if (headers) {
      requestInit.headers = headers;
    } else {
      delete requestInit.headers;
    }
  }
  return {
    ...config,
    ...(requestInit ? { requestInit } : {}),
  };
}

/**
 * Saves OAuth-related configuration to localStorage for reconnection purposes.
 * This persists server URL, scopes, headers, and non-secret client metadata.
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
  const hasExplicitHeaderPatch = Object.prototype.hasOwnProperty.call(
    formData.secretPatch ?? {},
    "headers"
  );
  const customHeaders = hasExplicitHeaderPatch
    ? formData.secretPatch?.headers ?? {}
    : {
        ...(existingOAuthConfig.customHeaders ?? {}),
        ...(formData.headers ?? {}),
      };
  if (Object.keys(customHeaders).length > 0) {
    oauthConfig.customHeaders = customHeaders;
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

  if (formData.clientId) {
    const clientInfo: Record<string, string> = {};
    if (formData.clientId) {
      clientInfo.client_id = formData.clientId;
    }
    localStorage.setItem(
      `mcp-client-${formData.name}`,
      JSON.stringify(clientInfo)
    );
  } else {
    localStorage.removeItem(`mcp-client-${formData.name}`);
  }
}

export function buildElectronMcpCallbackUrl(): string | null {
  if (window.isElectron || window.location.pathname !== "/oauth/callback") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  if (!params.get("code") && !params.get("error")) {
    return null;
  }

  // Electron-started MCP OAuth explicitly tags the state parameter so the
  // browser callback can hand control back to the desktop app without relying
  // on browser-local storage heuristics.
  if (!isElectronMcpCallbackState(params.get("state"))) {
    return null;
  }

  const callbackUrl = new URL("mcpjam://oauth/callback");
  callbackUrl.searchParams.set("flow", "mcp");

  for (const [key, value] of params.entries()) {
    callbackUrl.searchParams.append(key, value);
  }

  return callbackUrl.toString();
}

const OAUTH_CONNECTION_RETRY_DELAY_MS = 1500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
    if (parsed && typeof parsed === "object" && "client_secret" in parsed) {
      const sanitized = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key !== "client_secret")
      );
      localStorage.setItem(
        `mcp-client-${serverName}`,
        JSON.stringify(sanitized)
      );
    }
    return {
      clientId:
        typeof parsed?.client_id === "string" && parsed.client_id.trim() !== ""
          ? parsed.client_id
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
    clientSecret: "",
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
    clientSecret: "",
    scopes: formData.oauthScopes?.join(",") ?? existingProfile?.scopes ?? "",
    customHeaders,
    protocolVersion,
    registrationStrategy,
  };
}

function restorePathAfterOAuthCallback(
  currentPathname: string,
  savedTarget: string
): string {
  const basePath =
    currentPathname === "/oauth/callback"
      ? routePaths.servers
      : currentPathname;
  return savedTarget
    ? normalizeReturnTargetPath(savedTarget, basePath)
    : basePath;
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
    normalized.includes("no hosted oauth credential found") ||
    normalized.includes(
      "stored hosted oauth credential is missing refresh_token"
    ) ||
    (normalized.includes("authentication failed") &&
      normalized.includes("invalid_token"))
  );
}

export function shouldRetryOAuthConnectionFailure(
  errorMessage?: string
): boolean {
  if (!errorMessage) {
    return false;
  }

  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes("authentication failed") ||
    normalized.includes("invalid_client") ||
    normalized.includes("unauthorized_client")
  ) {
    return false;
  }

  return (
    normalized.includes("request timed out") ||
    normalized.includes("streamable http error") ||
    (normalized.includes("non-200 status code") && normalized.includes("404"))
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
  /**
   * The active project default hostConfig's mcpProfile envelope, when
   * one is set. Supplied by `use-app-state` via the
   * `hostConfigsV2.getProjectDefault` query. `undefined` means "use SDK
   * defaults" — preserves historical wire behavior on /api/mcp/connect
   * for users who haven't opted into mcpProfile. Forwarded by every
   * resolver-path connect site into ConnectionDefaults so the SDK pins
   * clientInfo / supportedProtocolVersions accordingly.
   */
  activeMcpProfile?: import("@/lib/client-config-v2").HostConfigMcpProfileV1;
  /**
   * When a named host is active (e.g. selected in ChatTabV2 or HostBuilderView
   * preview), its connectionDefaults replace the project-level connection
   * defaults in `withProjectConnectionDefaults`. Per-server overrides are
   * applied when the call site also supplies the `serverId`.
   */
  activeHostConfig?: HostConfigDtoV2;
  requestSignIn?: () => void | Promise<void>;
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
  activeMcpProfile,
  activeHostConfig,
  requestSignIn,
  logger,
}: UseServerStateParams) {
  const isUserReady = useDbUserReady();
  const convex = useConvex();
  const {
    createServerIfMissing: convexCreateServerIfMissing,
    updateServer: convexUpdateServer,
    createServerWithClientSecret: convexCreateServerWithClientSecret,
    updateServerWithClientSecret: convexUpdateServerWithClientSecret,
    deleteServer: convexDeleteServer,
  } = useServerMutations();

  const hasSignedInUserRef = useRef(hasSignedInUser);
  hasSignedInUserRef.current = hasSignedInUser;
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const isUserReadyRef = useRef(isUserReady);
  isUserReadyRef.current = isUserReady;
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

      const returnPath = captureCurrentReturnPath();
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
        returnPath,
      });
      if (returnPath) {
        localStorage.setItem("mcp-oauth-return-hash", returnPath);
      }
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

    if (!isAuthenticated || useLocalFallback) {
      // Surface runtime-only servers only in local/fallback state. For
      // Convex-backed projects the server list must come from the Convex
      // project-server queries, otherwise runtime state can leak across
      // logout, guest handoff, or organization switches.
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
    }

    return { ...project, servers: serversWithRuntime };
  }, [
    effectiveProjects,
    effectiveActiveProjectId,
    appState.servers,
    isAuthenticated,
    useLocalFallback,
  ]);

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

  // What chat-input's "Servers" popover (and any other "show me everything
  // we can talk to" surface) should iterate: the project catalog PLUS any
  // runtime-connected/connecting servers that aren't in it yet. The catalog
  // (effectiveServers) is the Convex `project_servers` query in hosted mode
  // and can lag mcpjam-backend's `MCPClientManager` — a server is genuinely
  // connected (Tools pane and tool calls work against it) but its catalog
  // row hasn't synced, so the popover used to hide it. We only merge
  // runtime entries that are currently connected/connecting; disconnected
  // runtime leftovers from a previous session/project never surface here.
  const displayServerConfigs = useMemo(() => {
    const result: Record<string, ServerWithName> = { ...effectiveServers };
    for (const [name, runtime] of Object.entries(appState.servers)) {
      if (result[name]) continue;
      if (
        runtime.connectionStatus !== "connected" &&
        runtime.connectionStatus !== "connecting"
      ) {
        continue;
      }
      result[name] = runtime;
    }
    return result;
  }, [effectiveServers, appState.servers]);

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
    (serverConfig: MCPServerConfig, serverId?: string): MCPServerConfig => {
      // Capability precedence: per-server explicit override → active host
      // (always the single source for the global tab scope) → project
      // clientConfig shadow (transient, only when activeHostConfig hasn't
      // hydrated yet). The host is the only authoritative source once
      // provisioned — `projects.clientConfig` is a backend-maintained
      // shadow-mirror of the project default host.
      const effectiveClientCapabilities = activeHostConfig
        ? resolveEffectiveClientCapabilities({
            host: activeHostConfig,
            serverConfig,
          })
        : resolveEffectiveClientCapabilities({
            host: activeProject?.clientConfig
              ? ({
                  clientCapabilities:
                    activeProject.clientConfig.clientCapabilities,
                } as Pick<HostConfigDtoV2, "clientCapabilities">)
              : null,
            serverConfig,
          });

      let nextRequestInit = serverConfig.requestInit;
      if ("url" in serverConfig) {
        let mergedHeaders: Record<string, string>;
        let effectiveTimeout: number;

        if (activeHostConfig) {
          // Use host-level connection defaults + optional per-server override
          const serverBase = {
            headers: extractRequestHeaders(serverConfig.requestInit),
            timeout: serverConfig.timeout,
          };
          const perServerOverride = serverId
            ? activeHostConfig.serverConnectionOverrides?.[serverId]
            : undefined;
          const resolved = resolveServerConnectionSettings(
            serverBase,
            activeHostConfig.connectionDefaults,
            perServerOverride
          );
          mergedHeaders = resolved.headers;
          effectiveTimeout = resolved.timeout;
        } else {
          mergedHeaders = mergeProjectConnectionHeaders(
            projectConnectionDefaults.headers,
            extractRequestHeaders(serverConfig.requestInit)
          );
          effectiveTimeout =
            serverConfig.timeout ?? projectConnectionDefaults.requestTimeout;
        }

        if (Object.keys(mergedHeaders).length > 0) {
          nextRequestInit = {
            ...(serverConfig.requestInit ?? {}),
            headers: mergedHeaders,
          };
        }

        return {
          ...serverConfig,
          ...(nextRequestInit ? { requestInit: nextRequestInit } : {}),
          timeout: effectiveTimeout,
          capabilities: effectiveClientCapabilities,
          clientCapabilities: effectiveClientCapabilities,
        } as MCPServerConfig;
      }

      return {
        ...serverConfig,
        timeout: activeHostConfig
          ? activeHostConfig.connectionDefaults.requestTimeout ??
            serverConfig.timeout ??
            projectConnectionDefaults.requestTimeout
          : serverConfig.timeout ?? projectConnectionDefaults.requestTimeout,
        capabilities: effectiveClientCapabilities,
        clientCapabilities: effectiveClientCapabilities,
      } as MCPServerConfig;
    },
    [activeProject?.clientConfig, projectConnectionDefaults, activeHostConfig]
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
    (
      serverConfig: MCPServerConfig,
      // Optional mcpProfile (hostConfig.mcpProfile) that the caller has
      // already resolved from a chatbox/project context. When provided,
      // its `initialize.clientInfo` and first
      // `initialize.supportedProtocolVersions` entry flow onto the
      // ConnectionDefaults wire shape. Undefined preserves historical
      // behavior — connect runs without an mcpProfile pin and the SDK
      // falls back to its hardcoded defaults.
      mcpProfile?: import("@/lib/client-config-v2").HostConfigMcpProfileV1,
      // Server identifier used to look up per-server protocol-version
      // pins on `activeHostConfig.serverConnectionOverrides`. When
      // supplied, `resolveEffectiveMcpProtocolVersion(serverOverride,
      // hostDefault)` runs so a per-server dropdown choice actually
      // reaches the connect payload — without this argument, the host
      // default wins and per-server overrides are silently dropped (the
      // bug PR #2257 review flagged).
      serverId?: string
    ) => {
      const defaults: {
        headers?: Record<string, string>;
        timeoutMs?: number;
        clientCapabilities?: Record<string, unknown>;
        clientInfo?: { name?: string; version?: string } & Record<
          string,
          unknown
        >;
        supportedProtocolVersions?: string[];
        mcpProtocolVersion?: import("@mcpjam/sdk/browser").McpProtocolVersion;
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
      const ci = mcpProfile?.initialize?.clientInfo;
      if (ci && typeof ci === "object" && !Array.isArray(ci)) {
        defaults.clientInfo = ci;
      }
      const versions = mcpProfile?.initialize?.supportedProtocolVersions;
      if (Array.isArray(versions) && versions.length > 0) {
        // Forward the full accept-list. First entry is what the SDK
        // proposes in `initialize.params.protocolVersion`; later entries
        // are accepted if the server negotiates one of them. Collapsing
        // to `[versions[0]]` was the prior shape and silently caused
        // "server speaks a later listed version → connect fails," which
        // defeats the point of letting users pin a multi-version list.
        defaults.supportedProtocolVersions = versions.filter(
          (v): v is string => typeof v === "string" && v.trim() !== ""
        );
      }
      // Effective pinned MCP protocol version: per-server override
      // (from `activeHostConfig.serverConnectionOverrides[serverId]
      // .mcpProtocolVersionOverride`) wins, otherwise the host default
      // from `mcpProfile.mcpProtocolVersion`, otherwise undefined
      // (preserves "SDK chooses" semantics). Membership-gate each
      // candidate via `isKnownProtocolVersion` so a typo on either
      // layer doesn't slip past to the SDK's open-routing predicate.
      const rawServerOverride =
        serverId && activeHostConfig
          ? activeHostConfig.serverConnectionOverrides?.[serverId]
              ?.mcpProtocolVersionOverride
          : undefined;
      const serverOverride: McpProtocolVersion | undefined =
        typeof rawServerOverride === "string" &&
        isKnownProtocolVersion(rawServerOverride)
          ? rawServerOverride
          : undefined;
      const rawHostPin = mcpProfile?.mcpProtocolVersion;
      const hostPin: McpProtocolVersion | undefined =
        typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
          ? rawHostPin
          : undefined;
      const effective = resolveEffectiveMcpProtocolVersion(
        serverOverride,
        hostPin
      );
      if (effective !== undefined) {
        defaults.mcpProtocolVersion = effective;
      }
      return Object.keys(defaults).length > 0 ? defaults : undefined;
    },
    [activeHostConfig]
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
          // Forward the active mcpProfile so the resolver path pins
          // clientInfo / supportedProtocolVersions on this connect.
          // Undefined preserves SDK defaults — no behavior change for
          // users without an mcpProfile.
          connectionDefaults: buildResolverConnectionDefaults(
            serverConfig,
            activeMcpProfile,
            resolved.serverId
          ),
        });
      }
      throw new Error(PROJECT_NOT_PROVISIONED_ERROR_MESSAGE);
    },
    [
      assertClientConfigSynced,
      buildResolverConnectionDefaults,
      activeMcpProfile,
    ]
  );

  const guardedReconnectServer = useCallback(
    async (serverName: string, serverConfig: MCPServerConfig) => {
      assertClientConfigSynced();
      const resolved = tryResolveProjectServer(serverName);
      if (resolved) {
        const configWithDefaults = withProjectConnectionDefaults(
          serverConfig,
          resolved.serverId
        );
        return reconnectServer(resolved.serverId, configWithDefaults, {
          projectId: resolved.projectId,
          serverName,
          connectionDefaults: buildResolverConnectionDefaults(
            configWithDefaults,
            activeMcpProfile,
            resolved.serverId
          ),
        });
      }
      throw new Error(PROJECT_NOT_PROVISIONED_ERROR_MESSAGE);
    },
    [
      assertClientConfigSynced,
      buildResolverConnectionDefaults,
      activeMcpProfile,
      withProjectConnectionDefaults,
    ]
  );

  // Shared with the forms that feed this save path (XAAServerModal, ...) so a
  // form can never pass a config the save path would reject and lose the
  // user's input. See lib/server-form-validation.
  const validateForm = validateServerFormData;

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
      secretOptions?: {
        clientSecret?: string;
        clearClientSecret?: boolean;
        env?: Record<string, string>;
        headers?: Record<string, string>;
      }
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
      const config = serverEntry.config as any;
      const headers = extractRequestHeaders(config?.requestInit);
      const hasEnvSecretPatch = Object.prototype.hasOwnProperty.call(
        secretOptions ?? {},
        "env"
      );
      const hasHeadersSecretPatch = Object.prototype.hasOwnProperty.call(
        secretOptions ?? {},
        "headers"
      );
      if (clientSecret && clearClientSecret) {
        throw new Error(
          "Cannot replace and clear the OAuth client secret in the same save."
        );
      }
      const hasSecretOperation = Boolean(
        clientSecret ||
          clearClientSecret ||
          hasEnvSecretPatch ||
          hasHeadersSecretPatch ||
          (!secretOptions && config?.env !== undefined) ||
          (!secretOptions && headers !== undefined)
      );

      // Resolve "does a server with this name already exist?" from the local
      // snapshot when possible, then fall back to a one-shot Convex query
      // during loading windows. When no row is visible, the no-secret write
      // path still uses the backend create-if-missing mutation so the final
      // decision is atomic.
      const resolveExistingServer = async (
        snapshot: RemoteServer[] | undefined,
        options?: { queryWhenLoaded?: boolean }
      ): Promise<RemoteServer | undefined> => {
        const local = snapshot?.find((s) => s.name === serverName);
        if (local) return local;
        if (snapshot !== undefined && options?.queryWhenLoaded !== true) {
          return undefined;
        }
        if (!isUserReadyRef.current) {
          return undefined;
        }
        try {
          const fresh = (await convex.query(
            "servers:getProjectServers" as any,
            { projectId: latestProjectId } as any
          )) as RemoteServer[] | undefined;
          return fresh?.find((s) => s.name === serverName);
        } catch {
          return undefined;
        }
      };

      const existingServer = await resolveExistingServer(flatSnapshot);

      const transportType = config?.command ? "stdio" : "http";
      const url =
        config?.url instanceof URL ? config.url.href : config?.url || undefined;
      const envForPayload = secretOptions
        ? hasEnvSecretPatch
          ? secretOptions.env
          : undefined
        : config?.env;
      const headersForPayload = secretOptions
        ? hasHeadersSecretPatch
          ? secretOptions.headers
          : undefined
        : headers;
      const storedOAuthConfig = readStoredOAuthConfig(serverName);

      const payload = {
        name: serverName,
        enabled: serverEntry.enabled ?? false,
        transportType,
        command: config?.command,
        args: config?.args,
        ...(envForPayload !== undefined ? { env: envForPayload } : {}),
        url,
        ...(headersForPayload !== undefined
          ? { headers: headersForPayload }
          : {}),
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
        ...(serverEntry.xaaAuthzIssuer !== undefined
          ? { xaaAuthzIssuer: serverEntry.xaaAuthzIssuer }
          : {}),
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
        const newId = hasSecretOperation
          ? await convexCreateServerWithClientSecret(createPayload)
          : await convexCreateServerIfMissing(createPayload);
        return newId as string | undefined;
      } catch (primaryError) {
        const primaryErrorMessage =
          primaryError instanceof Error
            ? primaryError.message
            : "Unknown error";
        // Best-effort fallback for stale query snapshots:
        // if update failed, try create; if create failed, try update when possible.
        try {
          if (existingServer) {
            const createPayload = {
              projectId: latestProjectId,
              ...payload,
              ...(clientSecret ? { clientSecret } : {}),
            };
            const newId = hasSecretOperation
              ? await convexCreateServerWithClientSecret(createPayload)
              : await convexCreateServerIfMissing(createPayload);
            return newId as string | undefined;
          }
          const flatRetry =
            activeProjectServersFlatRef.current ?? activeProjectServersFlat;
          const retryExisting = await resolveExistingServer(flatRetry, {
            queryWhenLoaded: true,
          });
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
          const createPayload = {
            projectId: latestProjectId,
            ...payload,
            ...(clientSecret ? { clientSecret } : {}),
          };
          const newId = hasSecretOperation
            ? await convexCreateServerWithClientSecret(createPayload)
            : await convexCreateServerIfMissing(createPayload);
          return newId as string | undefined;
        } catch (fallbackError) {
          logger.error("Failed to sync server to Convex", {
            serverName,
            primaryError: primaryErrorMessage,
            fallbackError:
              fallbackError instanceof Error
                ? fallbackError.message
                : "Unknown error",
          });
          return undefined;
        }
      }
    },
    [
      activeProjectServersFlat,
      convex,
      convexCreateServerIfMissing,
      convexUpdateServer,
      convexCreateServerWithClientSecret,
      convexUpdateServerWithClientSecret,
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

  // Re-validate already-connected servers when the resolved effective
  // `mcpProtocolVersion` for them changes — either because the host-level
  // default flipped or a per-server override moved. The pinned wire mode
  // is part of every subsequent request payload (via
  // `buildResolverConnectionDefaults`), so a server that no longer speaks
  // the pinned version will fail every call after the switch; without this
  // re-test the durable "Connected" pill keeps lying until the user manually
  // toggles the server.
  //
  // Behavior:
  // - On the first observation of a connected server, seed the last-applied
  //   map without re-testing (so steady-state mounts don't trigger probes).
  // - On a subsequent observation where the resolved version differs, kick
  //   off `guardedReconnectServer` (which threads the new pin through
  //   `buildResolverConnectionDefaults` / `withProjectConnectionDefaults`).
  //   Dispatch `CONNECT_SUCCESS` or `CONNECT_FAILURE` based on the result so
  //   the toggle reflects reality.
  // - Race protection via the existing `nextOpToken` / `isStaleOp` pattern,
  //   so a user-initiated disconnect or another pin change supersedes an
  //   in-flight re-test.
  // - Drop entries for servers no longer in "connected" status so a manual
  //   reconnect re-seeds against the live pin rather than against whatever
  //   was last seen.
  const lastAppliedProtocolVersionRef = useRef<
    Map<string, McpProtocolVersion | undefined>
  >(new Map());
  useEffect(() => {
    const rawHostPin = activeMcpProfile?.mcpProtocolVersion;
    const hostPin: McpProtocolVersion | undefined =
      typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
        ? rawHostPin
        : undefined;

    const observed = new Set<string>();
    for (const [name, server] of Object.entries(appState.servers)) {
      if (server.connectionStatus !== "connected") continue;
      observed.add(name);

      const resolved = tryResolveProjectServer(name);
      const serverId = resolved?.serverId;
      const rawOverride =
        serverId && activeHostConfig
          ? activeHostConfig.serverConnectionOverrides?.[serverId]
              ?.mcpProtocolVersionOverride
          : undefined;
      const serverOverride: McpProtocolVersion | undefined =
        typeof rawOverride === "string" && isKnownProtocolVersion(rawOverride)
          ? rawOverride
          : undefined;
      const resolvedPin = resolveEffectiveMcpProtocolVersion(
        serverOverride,
        hostPin
      );
      // Gate removed — stateless-mcp-enabled goes permanent 2026-05-27.
      const effective: McpProtocolVersion | undefined = resolvedPin;

      const seenBefore = lastAppliedProtocolVersionRef.current.has(name);
      const previous = lastAppliedProtocolVersionRef.current.get(name);
      lastAppliedProtocolVersionRef.current.set(name, effective);

      // Initial observation seeds without probing.
      if (!seenBefore) continue;
      if (previous === effective) continue;

      // Resolved pin changed for a connected server. Re-test asynchronously;
      // dispatch CONNECT_FAILURE if the server can't speak the new wire mode
      // (e.g. legacy 2025 server with the host now pinned to a draft).
      const serverConfig = server.config;
      const useOAuth = server.useOAuth ?? false;
      const token = nextOpToken(name);
      void (async () => {
        try {
          const result = await guardedReconnectServer(name, serverConfig);
          if (isStaleOp(name, token)) return;
          if (result?.success) {
            dispatch({
              type: "CONNECT_SUCCESS",
              name,
              config: serverConfig,
              tokens: undefined,
              useOAuth,
            });
            if (result.initInfo) {
              await storeInitInfo(name, result.initInfo).catch(() => {});
            }
            return;
          }
          const errorMessage =
            (typeof result?.error === "string" && result.error.length > 0
              ? result.error
              : undefined) ??
            `Server does not speak the pinned MCP protocol version (${
              effective ?? "default"
            })`;
          // Thread backend-attached normalized so the reducer doesn't
          // re-derive a less-specific slug from just the message string.
          const reTestNormalized = (result as { normalized?: unknown })
            ?.normalized;
          dispatch({
            type: "CONNECT_FAILURE",
            name,
            error: errorMessage,
            ...(reTestNormalized && typeof reTestNormalized === "object"
              ? { normalized: reTestNormalized as NormalizedError }
              : {}),
          });
        } catch (error) {
          if (isStaleOp(name, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name,
            error:
              error instanceof Error
                ? error.message
                : "Connection re-test failed after protocol version change",
          });
        }
      })();
    }

    // Drop entries for servers no longer in "connected" status so the next
    // manual connect re-seeds against the current pin.
    for (const name of Array.from(
      lastAppliedProtocolVersionRef.current.keys()
    )) {
      if (!observed.has(name)) {
        lastAppliedProtocolVersionRef.current.delete(name);
      }
    }
  }, [
    appState.servers,
    activeMcpProfile?.mcpProtocolVersion,
    activeHostConfig,
    dispatch,
    guardedReconnectServer,
    storeInitInfo,
  ]);

  const testConnectionAfterOAuth = useCallback(
    async (serverConfig: MCPServerConfig, serverName: string) => {
      try {
        const firstResult = await guardedTestConnection(
          serverConfig,
          serverName
        );
        if (
          firstResult.success ||
          !shouldRetryOAuthConnectionFailure(firstResult.error)
        ) {
          return firstResult;
        }

        logger.warn(
          "Retrying OAuth connection after transient transport error",
          {
            serverName,
            error: firstResult.error,
          }
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown connection error";
        if (!shouldRetryOAuthConnectionFailure(errorMessage)) {
          throw error;
        }

        logger.warn("Retrying OAuth connection after transport exception", {
          serverName,
          error: errorMessage,
        });
      }

      await delay(OAUTH_CONNECTION_RETRY_DELAY_MS);
      return guardedTestConnection(serverConfig, serverName);
    },
    [guardedTestConnection, logger]
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
        }
        if (result.success) {
          localStorage.removeItem("mcp-oauth-pending");
        }

        if (result.success && result.serverConfig && result.serverName) {
          const serverName = result.serverName;
          // Prefer the runtime entry over the project catalog: it holds the
          // user's freshly-saved OAuth config (clientId/secret/scopes/issuer),
          // which the catalog round-trip can lag or drop. Rebuilding from the
          // catalog here — then syncing back — is what reset the config after a
          // reconnect that needed re-auth.
          const existingServer =
            appStateServersRef.current[serverName] ??
            latestEffectiveServersRef.current[serverName];
          const mergedServerConfig = mergeOAuthCallbackServerConfig(
            existingServer?.config,
            result.serverConfig
          );
          const storedOAuthConfig = readStoredOAuthConfig(serverName);
          const storedClientCredentials =
            readStoredClientCredentials(serverName);
          const resolvedOAuthProfile = buildResolvedOAuthProfile({
            serverName,
            serverUrl: String(mergedServerConfig.url),
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
            xaaAuthzIssuer: existingServer?.xaaAuthzIssuer,
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
            const connectionResult = await testConnectionAfterOAuth(
              withProjectConnectionDefaults(mergedServerConfig),
              serverName
            );
            if (connectionResult.success) {
              dispatch({
                type: "CONNECT_SUCCESS",
                name: serverName,
                config: mergedServerConfig,
                tokens: undefined,
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
                normalized: (connectionResult as { normalized?: unknown })
                  .normalized as any,
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
      testConnectionAfterOAuth,
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
    const electronCallbackUrl = buildElectronMcpCallbackUrl();
    const hostedOAuthCallbackContext = HOSTED_MODE
      ? getHostedOAuthCallbackContext()
      : null;
    if (electronCallbackUrl) {
      return;
    }
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
        ...(formData.secretPatch?.env !== undefined
          ? { env: formData.secretPatch.env }
          : {}),
        ...(formData.secretPatch?.headers !== undefined
          ? { headers: formData.secretPatch.headers }
          : {}),
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
        hasEnv:
          formData.secretPatch?.env !== undefined
            ? Object.keys(formData.secretPatch.env).length > 0
            : existingServerForSave?.hasEnv,
        hasHeaders:
          formData.secretPatch?.headers !== undefined
            ? Object.keys(formData.secretPatch.headers).length > 0
            : existingServerForSave?.hasHeaders,
        xaaAuthzIssuer:
          formData.xaaAuthzIssuer ?? existingServerForSave?.xaaAuthzIssuer,
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
        // credential. Local-mode OAuth is guarded later when tokens are
        // imported into backend storage instead of being saved locally.
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
          const serverConfig = {
            url: formData.url,
            ...(formData.headers && Object.keys(formData.headers).length > 0
              ? { requestInit: { headers: formData.headers } }
              : {}),
          } satisfies HttpServerConfig;
          logger.info("Connecting with synced OAuth credentials", {
            serverName: formData.name,
          });
          const storedCredentialResult = await guardedTestConnection(
            withProjectConnectionDefaults(serverConfig),
            formData.name
          );
          if (isStaleOp(formData.name, token)) return;
          if (storedCredentialResult.success) {
            dispatch({
              type: "CONNECT_SUCCESS",
              name: formData.name,
              config: serverConfig,
              tokens: undefined,
              useOAuth: true,
            });
            toast.success("Connected successfully with OAuth!");
            storeInitInfo(formData.name, storedCredentialResult.initInfo).catch(
              (err) =>
                logger.warn("Failed to fetch init info", {
                  serverName: formData.name,
                  err,
                })
            );
            return;
          }
          if (!requiresFreshOAuthAuthorization(storedCredentialResult.error)) {
            const errorMessage =
              storedCredentialResult.error || "OAuth connection failed";
            dispatch({
              type: "CONNECT_FAILURE",
              name: formData.name,
              error: errorMessage,
              normalized: (storedCredentialResult as { normalized?: unknown })
                .normalized as any,
            });
            toast.error(errorMessage);
            return;
          }
          logger.info("Synced OAuth credentials require a fresh OAuth flow", {
            serverName: formData.name,
            error: storedCredentialResult.error,
          });

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
              const oauthServerConfig = stripAuthorizationFromHttpConfig(
                oauthResult.serverConfig
              );
              const connectionResult = await guardedTestConnection(
                withProjectConnectionDefaults(oauthServerConfig),
                formData.name
              );
              if (isStaleOp(formData.name, token)) return;
              if (connectionResult.success) {
                dispatch({
                  type: "CONNECT_SUCCESS",
                  name: formData.name,
                  config: oauthServerConfig,
                  tokens: undefined,
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
            // Thread the backend-attached rich block through. Without this
            // the reducer's auto-derive would re-classify from just the
            // message string and lose the slug the backend already pinned
            // (e.g. `transport/econnrefused` from a Node errno match).
            ...(result.normalized ? { normalized: result.normalized } : {}),
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
      options?: { oauthProfile?: OAuthTestProfile; suppressToast?: boolean }
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
        hasEnv:
          formData.secretPatch?.env !== undefined
            ? Object.keys(formData.secretPatch.env).length > 0
            : existingServer?.hasEnv,
        hasHeaders:
          formData.secretPatch?.headers !== undefined
            ? Object.keys(formData.secretPatch.headers).length > 0
            : existingServer?.hasHeaders,
        xaaAuthzIssuer:
          formData.xaaAuthzIssuer ?? existingServer?.xaaAuthzIssuer,
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
            ...(formData.secretPatch?.env !== undefined
              ? { env: formData.secretPatch.env }
              : {}),
            ...(formData.secretPatch?.headers !== undefined
              ? { headers: formData.secretPatch.headers }
              : {}),
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
      if (!options?.suppressToast) {
        toast.success(`Saved configuration for ${serverName}`);
      }
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
      if (!HOSTED_MODE && tokens.clientId) {
        localStorage.setItem(
          `mcp-client-${serverName}`,
          JSON.stringify({
            client_id: tokens.clientId,
          })
        );
      }

      if (!HOSTED_MODE) {
        localStorage.setItem(`mcp-serverUrl-${serverName}`, serverUrl);
      }

      const resolved = tryResolveProjectServer(serverName);
      const normalizedTokens = normalizeImportHostedOAuthTokens(tokenData);
      if (!resolved) {
        localStorage.removeItem(`mcp-tokens-${serverName}`);
        return {
          success: false,
          error: "OAuth server is not synced; cannot store tokens securely",
        };
      }
      if (!normalizedTokens) {
        localStorage.removeItem(`mcp-tokens-${serverName}`);
        return {
          success: false,
          error:
            "OAuth token response missing access_token; cannot import tokens to Convex",
        };
      }
      if (!tokens.clientId) {
        localStorage.removeItem(`mcp-tokens-${serverName}`);
        return {
          success: false,
          error:
            "OAuth client information missing client_id; cannot import tokens to Convex",
        };
      }
      const storedOAuthConfig = readStoredOAuthConfig(serverName);
      const isRegistry =
        !!storedOAuthConfig.registryServerId &&
        storedOAuthConfig.useRegistryOAuthProxy === true;
      await importHostedOAuthTokens({
        projectId: resolved.projectId,
        serverId: resolved.serverId,
        serverUrl,
        ...(storedOAuthConfig.resourceUrl
          ? { oauthResourceUrl: storedOAuthConfig.resourceUrl }
          : {}),
        kind: isRegistry ? "registry" : "generic",
        ...(isRegistry
          ? {
              registryServerId: storedOAuthConfig.registryServerId,
              useRegistryOAuthProxy: true,
            }
          : {}),
        clientInformation: {
          clientId: tokens.clientId,
          ...(tokens.clientSecret ? { clientSecret: tokens.clientSecret } : {}),
        },
        tokens: normalizedTokens,
      });
      localStorage.removeItem(`mcp-tokens-${serverName}`);

      const serverConfig = {
        url: serverUrl,
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
            tokens: undefined,
            useOAuth: true,
          });
          await storeInitInfo(serverName, result.initInfo);
          return { success: true };
        }
        // OAuth reconnect failure: preserve the backend-attached
        // normalized block for the same reason as the other dispatch
        // sites — the reducer's auto-derive only sees the message
        // string and produces a less specific slug than the backend
        // already pinned (e.g. via Node errno match).
        const oauthReconnectNormalized = (result as { normalized?: unknown })
          .normalized;
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: result.error || "Connection failed",
          ...(oauthReconnectNormalized &&
          typeof oauthReconnectNormalized === "object"
            ? { normalized: oauthReconnectNormalized as NormalizedError }
            : {}),
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
  const cliConfigFetchStartedRef = useRef<boolean>(false);
  const cliConfigSignInRequestedRef = useRef<boolean>(false);
  const pendingCliConfigRef = useRef<any | null>(null);

  useEffect(() => {
    if (HOSTED_MODE) {
      return;
    }
    if (cliConfigProcessedRef.current) {
      return;
    }
    if (isLoading || isAuthLoading) {
      return;
    }

    const oauthCallbackInProgress = new URLSearchParams(
      window.location.search
    ).has("code");

    const applyCliUiConfig = (cliConfig: any) => {
      if (
        cliConfig.initialTab &&
        (!window.location.pathname || window.location.pathname === "/")
      ) {
        const tab = cliConfig.initialTab.replace(/^[#/]+/, "");
        if (tab) {
          navigateApp(`/${tab}`, { replace: true });
        }
      }

      if (
        cliConfig.cspMode === "permissive" ||
        cliConfig.cspMode === "widget-declared"
      ) {
        const store = useUIPlaygroundStore.getState();
        store.setCspMode(cliConfig.cspMode);
        store.setMcpAppsCspMode(cliConfig.cspMode);
      }
    };

    const hasServerPayload = (cliConfig: any): boolean =>
      Boolean(
        (Array.isArray(cliConfig.servers) && cliConfig.servers.length > 0) ||
          cliConfig.command
      );

    const formDataFromCliServer = (
      server: any,
      fallbackName = "CLI Server"
    ): ServerFormData => ({
      name: server.name || fallbackName,
      type: (server.type === "sse" ? "http" : server.type || "stdio") as
        | "stdio"
        | "http",
      command: server.command,
      args: server.args || [],
      url: server.url,
      env: server.env || {},
      headers: server.headers,
      secretPatch: {
        ...(server.env !== undefined ? { env: server.env || {} } : {}),
        ...(server.headers !== undefined
          ? { headers: server.headers || {} }
          : {}),
      },
      useOAuth: server.useOAuth ?? false,
    });

    const requestCliSignIn = () => {
      if (cliConfigSignInRequestedRef.current) {
        return;
      }
      cliConfigSignInRequestedRef.current = true;
      writeCliSignInReturnPath(
        `${window.location.pathname || routePaths.root}${
          window.location.search || ""
        }`
      );
      void requestSignIn?.();
    };

    const processCliConfig = async (cliConfig: any) => {
      applyCliUiConfig(cliConfig);

      if (!hasServerPayload(cliConfig)) {
        cliConfigProcessedRef.current = true;
        return;
      }

      if (!hasSignedInUser) {
        if (oauthCallbackInProgress) {
          logger.info("Skipping CLI sign-in redirect during OAuth callback");
          return;
        }
        requestCliSignIn();
        return;
      }

      const hasActiveConvexProject = Boolean(
        activeProject?.sharedProjectId &&
          effectiveActiveProjectId &&
          effectiveActiveProjectId !== "none" &&
          !useLocalFallback
      );
      if (isLoadingProjects || !hasActiveConvexProject) {
        return;
      }

      cliConfigProcessedRef.current = true;

      if (Array.isArray(cliConfig.servers) && cliConfig.servers.length > 0) {
        const autoConnectServer = cliConfig.autoConnectServer;

        logger.info("Processing CLI-provided MCP servers (from config file)", {
          serverCount: cliConfig.servers.length,
          autoConnectServer: autoConnectServer || "all",
          cliConfig,
        });

        for (const server of cliConfig.servers) {
          const serverName = server.name || "CLI Server";
          const formData = formDataFromCliServer(server, serverName);

          if (oauthCallbackInProgress && server.useOAuth) {
            logger.info("Skipping auto-connect for OAuth server", {
              serverName,
              reason: "OAuth callback in progress",
            });
            await saveServerConfigWithoutConnecting(formData, {
              suppressToast: true,
            });
          } else if (!autoConnectServer || server.name === autoConnectServer) {
            logger.info("Auto-connecting to server", {
              serverName,
            });
            await handleConnect(formData);
          } else {
            logger.info("Saving CLI server without auto-connect", {
              serverName,
              reason: "filtered out",
            });
            await saveServerConfigWithoutConnecting(formData, {
              suppressToast: true,
            });
          }
        }
        return;
      }

      if (cliConfig.command) {
        logger.info("Auto-connecting to CLI-provided MCP server", {
          cliConfig,
        });
        const formData = formDataFromCliServer(
          {
            ...cliConfig,
            type: "stdio",
          },
          cliConfig.name || "CLI Server"
        );
        await handleConnect(formData);
      }
    };

    const pendingCliConfig = pendingCliConfigRef.current;
    if (pendingCliConfig) {
      void processCliConfig(pendingCliConfig);
      return;
    }

    if (cliConfigFetchStartedRef.current) {
      return;
    }

    cliConfigFetchStartedRef.current = true;
    authFetch("/api/mcp-cli-config")
      .then((response) => response.json())
      .then((data) => {
        const cliConfig = data.config ?? null;
        pendingCliConfigRef.current = cliConfig;
        if (!cliConfig) {
          cliConfigProcessedRef.current = true;
          return;
        }
        void processCliConfig(cliConfig);
      })
      .catch((error) => {
        logger.debug("Could not fetch CLI config from API", { error });
        cliConfigProcessedRef.current = true;
      });
  }, [
    isLoading,
    isAuthLoading,
    isLoadingProjects,
    hasSignedInUser,
    useLocalFallback,
    effectiveActiveProjectId,
    activeProject?.sharedProjectId,
    requestSignIn,
    handleConnect,
    saveServerConfigWithoutConnecting,
    logger,
  ]);

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

  // Runtime-only counterpart to `handleDisconnect`. Just flips the in-memory
  // connection state to "disconnected" without going through `deleteServer`,
  // which in local mode would also remove the server's persisted config.
  // Used by host-switch auto-disconnect, where we want to drop the runtime
  // connection but keep the server entry intact so the user can re-connect
  // (or another host can require it) without re-adding the server.
  const handleRuntimeDisconnect = useCallback(
    (serverName: string) => {
      dispatch({ type: "DISCONNECT", name: serverName });
    },
    [dispatch]
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
        if (!projectIdForReconnect || projectIdForReconnect === "none") {
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
            undefined,
          hasClientSecret: Boolean(
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
        const oauthServerConfig = stripAuthorizationFromHttpConfig(
          oauthResult.serverConfig!
        );
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(oauthServerConfig)
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
            config: oauthServerConfig,
            tokens: undefined,
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

      if (server.useOAuth === true) {
        const syncedReconnectConfig = withProjectConnectionDefaults(
          server.config
        );
        try {
          const result = await guardedReconnectServer(
            serverName,
            syncedReconnectConfig
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
            logger.info("Reconnect successful using synced OAuth credentials", {
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
            logger.error("OAuth reconnect failed", { serverName, result });
            reportError(errorMessage || `Failed to reconnect: ${serverName}`);
            return {
              status: "failed",
              error: errorMessage,
            };
          }

          logger.info(
            "Reconnect requires a fresh OAuth flow after synced credential lookup",
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
            logger.error("OAuth reconnect failed", {
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
            "Reconnect requires a fresh OAuth flow after synced credential lookup",
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
        const authServerConfig =
          "url" in authResult.serverConfig
            ? stripAuthorizationFromHttpConfig(authResult.serverConfig)
            : authResult.serverConfig;
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(authServerConfig)
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
            config: authServerConfig,
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
          // Preserve the backend-attached normalized block so the reducer
          // doesn't have to re-derive a (less specific) slug from just
          // the message string.
          ...(result.normalized ? { normalized: result.normalized } : {}),
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

  // Force a re-handshake of an ALREADY-connected server under the current
  // client identity. Unlike `ensureServersReady` (which skips servers that are
  // already connected), this always reconnects — the backend
  // `/api/mcp/servers/reconnect` endpoint closes the live transport and reopens
  // it with the active host's `clientInfo`. Non-interactive and non-selecting:
  // used by the client-switch recycle, where popping an OAuth window per server
  // or thrashing the single-select pointer would be wrong. Per-server error
  // toasts are suppressed here; the caller aggregates failures for logging and
  // one user-facing toast.
  const reconnectServerForClientSwitch = useCallback(
    async (serverName: string): Promise<void> => {
      const result = await reconnectServerInternal(serverName, {
        allowInteractiveOAuthFlow: false,
        select: false,
        suppressErrors: true,
      });
      if (result.status !== "connected") {
        throw new Error(result.error || `Failed to reconnect ${serverName}`);
      }
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
          xaaAuthzIssuer:
            formData.xaaAuthzIssuer ?? originalServer?.xaaAuthzIssuer,
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
    displayServerConfigs,
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
    handleRuntimeDisconnect,
    handleReconnect,
    reconnectServerForClientSwitch,
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
