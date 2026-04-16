import { useCallback, useEffect, useMemo, useRef, type Dispatch } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import type {
  ConnectContext,
  HttpServerConfig,
  MCPServerConfig,
} from "@mcpjam/sdk/browser";
import type {
  AppAction,
  AppState,
  ServerWithName,
  Workspace,
} from "@/state/app-types";
import { isConnectedStatus } from "@/state/app-types";
import {
  testConnection,
  deleteServer,
  listServers,
  reconnectServer,
  getInitializationInfo,
  type ConnectionApiResponse,
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
  type MCPOAuthOptions,
  readStoredOAuthConfig,
} from "@/lib/oauth/mcp-oauth";
import {
  clearHostedOAuthPendingState,
  getHostedOAuthCallbackContext,
  writeHostedOAuthPendingMarker,
} from "@/lib/hosted-oauth-callback";
import { HOSTED_MODE } from "@/lib/config";
import { injectHostedServerMapping } from "@/lib/apis/web/context";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import { authFetch } from "@/lib/session-token";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useServerMutations, type RemoteServer } from "./useWorkspaces";
import {
  CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
  getEffectiveServerClientCapabilities,
} from "@/lib/client-config";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import { readOnboardingState } from "@/lib/onboarding-state";

/** Skip noisy connect toast while first-run App Builder onboarding is in progress. */
function shouldSuppressExcalidrawConnectToastForOnboarding(
  serverName: string,
): boolean {
  if (serverName !== EXCALIDRAW_SERVER_NAME) return false;
  const status = readOnboardingState()?.status;
  return status === "seen";
}

/**
 * Saves OAuth-related configuration to localStorage for reconnection purposes.
 * This persists server URL, scopes, headers, and client credentials.
 */
function saveOAuthConfigToLocalStorage(
  formData: ServerFormData,
  options?: {
    oauthProfile?: OAuthTestProfile;
    useRegistryOAuthProxy?: boolean;
    preserveExistingConfigFrom?: string;
  },
): void {
  if (formData.type !== "http" || !formData.useOAuth || !formData.url) {
    return;
  }

  localStorage.setItem(`mcp-serverUrl-${formData.name}`, formData.url);
  const existingConfig = options?.preserveExistingConfigFrom
    ? readStoredOAuthConfig(options.preserveExistingConfigFrom)
    : undefined;

  const oauthConfig: Record<string, unknown> = {};
  if (formData.oauthScopes && formData.oauthScopes.length > 0) {
    oauthConfig.scopes = formData.oauthScopes;
  }
  if (formData.headers && Object.keys(formData.headers).length > 0) {
    oauthConfig.customHeaders = formData.headers;
  }
  if (formData.registryServerId) {
    oauthConfig.registryServerId = formData.registryServerId;
  } else if (existingConfig?.registryServerId) {
    oauthConfig.registryServerId = existingConfig.registryServerId;
  }
  const useRegistryOAuthProxy =
    options?.useRegistryOAuthProxy ??
    (formData.useRegistryOAuthProxy === true
      ? true
      : existingConfig?.useRegistryOAuthProxy === true
        ? true
        : undefined);
  if (useRegistryOAuthProxy === true) {
    oauthConfig.useRegistryOAuthProxy = true;
  }
  const protocolVersion =
    options?.oauthProfile?.protocolVersion ?? existingConfig?.protocolVersion;
  if (protocolVersion) {
    oauthConfig.protocolVersion = protocolVersion;
  }
  const registrationStrategy =
    options?.oauthProfile?.registrationStrategy ??
    existingConfig?.registrationStrategy;
  if (registrationStrategy) {
    oauthConfig.registrationStrategy = registrationStrategy;
  }
  if (Object.keys(oauthConfig).length > 0) {
    localStorage.setItem(
      `mcp-oauth-config-${formData.name}`,
      JSON.stringify(oauthConfig),
    );
  }

  if (formData.clientId || formData.clientSecret) {
    const clientInfo: Record<string, string> = {};
    if (formData.clientId) {
      clientInfo.client_id = formData.clientId;
    }
    if (formData.clientSecret) {
      clientInfo.client_secret = formData.clientSecret;
    }
    localStorage.setItem(
      `mcp-client-${formData.name}`,
      JSON.stringify(clientInfo),
    );
  }
}

function readStoredClientInfo(serverName: string): {
  client_id?: string;
  client_secret?: string;
} | null {
  try {
    const raw = localStorage.getItem(`mcp-client-${serverName}`);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as {
      client_id?: unknown;
      client_secret?: unknown;
    };

    return {
      ...(typeof parsed.client_id === "string"
        ? { client_id: parsed.client_id }
        : {}),
      ...(typeof parsed.client_secret === "string"
        ? { client_secret: parsed.client_secret }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseOAuthScopes(scopes: string | undefined): string[] | undefined {
  if (!scopes) {
    return undefined;
  }

  const parsed = scopes
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}

function restorePathAfterOAuthCallback(
  currentPathname: string,
  savedHash: string,
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
  registryServerId?: string;
  scopes?: string[];
  useRegistryOAuthProxy: boolean;
}

interface UseServerStateParams {
  appState: AppState;
  dispatch: Dispatch<AppAction>;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  isLoadingWorkspaces: boolean;
  useLocalFallback: boolean;
  effectiveWorkspaces: Record<string, Workspace>;
  effectiveActiveWorkspaceId: string;
  activeWorkspaceServersFlat: RemoteServer[] | undefined;
  logger: LoggerLike;
}

export interface ServerUpdateResult {
  ok: boolean;
  serverName: string;
}

export function useServerState({
  appState,
  dispatch,
  isLoading,
  isAuthenticated,
  isAuthLoading,
  isLoadingWorkspaces,
  useLocalFallback,
  effectiveWorkspaces,
  effectiveActiveWorkspaceId,
  activeWorkspaceServersFlat,
  logger,
}: UseServerStateParams) {
  const convex = useConvex();
  const {
    createServer: convexCreateServer,
    updateServer: convexUpdateServer,
    deleteServer: convexDeleteServer,
  } = useServerMutations();

  const oauthCallbackHandledRef = useRef(false);
  const opTokenRef = useRef<Map<string, number>>(new Map());
  const nextOpToken = (name: string) => {
    const current = opTokenRef.current.get(name) ?? 0;
    const next = current + 1;
    opTokenRef.current.set(name, next);
    return next;
  };

  const failPendingOAuthConnection = useCallback(
    (errorMessage: string) => {
      const pendingServerName = localStorage.getItem("mcp-oauth-pending");
      if (pendingServerName) {
        dispatch({
          type: "CONNECT_FAILURE",
          name: pendingServerName,
          error: errorMessage,
        });
      }

      clearHostedOAuthPendingState();
      localStorage.removeItem("mcp-oauth-return-hash");
      localStorage.removeItem("mcp-oauth-pending");

      return pendingServerName;
    },
    [dispatch],
  );
  const isStaleOp = (name: string, token: number) =>
    (opTokenRef.current.get(name) ?? 0) !== token;

  const prepareHostedWorkspaceOAuthRedirect = useCallback(
    (params: {
      serverId?: string | null;
      serverName: string;
      serverUrl?: string | null;
    }): boolean => {
      if (
        !HOSTED_MODE ||
        !isAuthenticated ||
        !effectiveActiveWorkspaceId ||
        !params.serverId ||
        !params.serverUrl
      ) {
        return false;
      }

      const returnHash = window.location.hash || "#servers";
      clearHostedOAuthPendingState();
      writeHostedOAuthPendingMarker({
        surface: "workspace",
        workspaceId: effectiveActiveWorkspaceId,
        serverId: params.serverId,
        serverName: params.serverName,
        serverUrl: params.serverUrl,
        accessScope: "workspace_member",
        returnHash,
      });
      localStorage.setItem("mcp-oauth-return-hash", returnHash);
      return true;
    },
    [effectiveActiveWorkspaceId, isAuthenticated],
  );

  const activeWorkspace = useMemo(() => {
    const workspace = effectiveWorkspaces[effectiveActiveWorkspaceId];
    if (!workspace) {
      return undefined;
    }

    const serversWithRuntime: Record<string, ServerWithName> = {};
    for (const [name, server] of Object.entries(workspace.servers)) {
      const runtimeState = appState.servers[name];

      let envFromStorage: Record<string, string> | undefined;
      try {
        const stored = localStorage.getItem(`mcp-env-${name}`);
        if (stored) envFromStorage = JSON.parse(stored);
      } catch {
        // Ignore parse errors
      }

      let configWithEnv: MCPServerConfig = server.config;
      if (
        envFromStorage &&
        "command" in server.config &&
        typeof server.config.command === "string"
      ) {
        configWithEnv = { ...server.config, env: envFromStorage };
      }

      serversWithRuntime[name] = {
        ...server,
        config: configWithEnv,
        connectionStatus:
          runtimeState?.connectionStatus ??
          server.connectionStatus ??
          "disconnected",
        oauthTokens: runtimeState?.oauthTokens ?? server.oauthTokens,
        oauthFlowProfile:
          runtimeState?.oauthFlowProfile ?? server.oauthFlowProfile,
        initializationInfo:
          runtimeState?.initializationInfo ?? server.initializationInfo,
        lastConnectionTime:
          runtimeState?.lastConnectionTime ?? server.lastConnectionTime,
        retryCount: runtimeState?.retryCount ?? server.retryCount ?? 0,
        lastError: runtimeState?.lastError ?? server.lastError,
        lastConnectionReport:
          runtimeState?.lastConnectionReport ?? server.lastConnectionReport,
        enabled: runtimeState?.enabled ?? server.enabled,
        useOAuth: runtimeState?.useOAuth ?? server.useOAuth,
      };
    }

    return { ...workspace, servers: serversWithRuntime };
  }, [effectiveWorkspaces, effectiveActiveWorkspaceId, appState.servers]);

  const effectiveServers = useMemo(() => {
    return activeWorkspace?.servers || {};
  }, [activeWorkspace]);

  const isClientConfigSyncPending = useClientConfigStore(
    (state) =>
      state.isAwaitingRemoteEcho &&
      state.pendingWorkspaceId === effectiveActiveWorkspaceId,
  );

  const withWorkspaceClientCapabilities = useCallback(
    (serverConfig: MCPServerConfig): MCPServerConfig => {
      const mergedCapabilities = getEffectiveServerClientCapabilities({
        workspaceClientConfig: activeWorkspace?.clientConfig,
        serverCapabilities: serverConfig.capabilities as
          | Record<string, unknown>
          | undefined,
      });

      return {
        ...serverConfig,
        capabilities: mergedCapabilities,
        clientCapabilities: mergedCapabilities,
      };
    },
    [activeWorkspace?.clientConfig],
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

  const guardedTestConnection = useCallback(
    async (
      serverConfig: MCPServerConfig,
      serverName: string,
      oauthContext?: ConnectContext["oauth"],
    ) => {
      assertClientConfigSynced();
      return testConnection(serverConfig, serverName, oauthContext);
    },
    [assertClientConfigSynced],
  );

  const guardedReconnectServer = useCallback(
    async (
      serverName: string,
      serverConfig: MCPServerConfig,
      oauthContext?: ConnectContext["oauth"],
    ) => {
      assertClientConfigSynced();
      return reconnectServer(serverName, serverConfig, oauthContext);
    },
    [assertClientConfigSynced],
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

  const buildOAuthContext = useCallback(
    (options?: {
      serverName?: string;
      oauthProfile?: OAuthTestProfile;
      useRegistryOAuthProxy?: boolean;
      usedCustomClientCredentials?: boolean;
    }): ConnectContext["oauth"] | undefined => {
      const storedConfig = options?.serverName
        ? readStoredOAuthConfig(options.serverName)
        : undefined;
      const useRegistryOAuthProxy =
        options?.useRegistryOAuthProxy ??
        storedConfig?.useRegistryOAuthProxy === true;
      const protocolVersion =
        options?.oauthProfile?.protocolVersion ?? storedConfig?.protocolVersion;
      const registrationStrategy =
        options?.oauthProfile?.registrationStrategy ??
        storedConfig?.registrationStrategy;

      if (
        protocolVersion !== "2025-03-26" &&
        protocolVersion !== "2025-06-18" &&
        protocolVersion !== "2025-11-25"
      ) {
        return undefined;
      }

      if (protocolVersion === "2025-03-26") {
        if (
          registrationStrategy !== "dcr" &&
          registrationStrategy !== "preregistered"
        ) {
          return undefined;
        }
      } else if (
        registrationStrategy !== "dcr" &&
        registrationStrategy !== "preregistered" &&
        registrationStrategy !== "cimd"
      ) {
        return undefined;
      }

      const parsedClientInfo = options?.serverName
        ? readStoredClientInfo(options.serverName)
        : null;
      const usedCustomClientCredentials =
        options?.usedCustomClientCredentials ??
        Boolean(
          options?.oauthProfile?.clientId?.trim() ||
          options?.oauthProfile?.clientSecret?.trim() ||
          (!useRegistryOAuthProxy &&
            (parsedClientInfo?.client_id || parsedClientInfo?.client_secret)),
        );

      return {
        protocolVersion,
        registrationStrategy,
        usedCustomClientCredentials,
        useRegistryOAuthProxy,
      };
    },
    [],
  );

  const buildReconnectOAuthOptions = useCallback(
    (
      serverName: string,
      server: ServerWithName,
      serverUrl: string,
    ): MCPOAuthOptions => {
      const storedConfig = readStoredOAuthConfig(serverName);
      const storedClientInfo = readStoredClientInfo(serverName);
      const oauthProfile = server.oauthFlowProfile;
      const scopesFromProfile = parseOAuthScopes(oauthProfile?.scopes);
      const protocolVersion =
        oauthProfile?.protocolVersion ?? storedConfig.protocolVersion;
      const registrationStrategy =
        oauthProfile?.registrationStrategy ?? storedConfig.registrationStrategy;
      const clientId =
        oauthProfile?.clientId?.trim() ||
        server.oauthTokens?.client_id ||
        storedClientInfo?.client_id;
      const clientSecret =
        oauthProfile?.clientSecret?.trim() ||
        server.oauthTokens?.client_secret ||
        storedClientInfo?.client_secret;

      return {
        serverName,
        serverUrl,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...((scopesFromProfile ?? storedConfig.scopes)
          ? { scopes: scopesFromProfile ?? storedConfig.scopes }
          : {}),
        ...(protocolVersion ? { protocolVersion } : {}),
        ...(registrationStrategy ? { registrationStrategy } : {}),
        ...(storedConfig.registryServerId
          ? { registryServerId: storedConfig.registryServerId }
          : {}),
        ...(storedConfig.useRegistryOAuthProxy
          ? { useRegistryOAuthProxy: true }
          : {}),
      };
    },
    [],
  );

  const getConnectionErrorMessage = useCallback(
    (result: ConnectionApiResponse | { error?: string }) =>
      result.report?.issue?.message ?? result.error ?? "Connection failed",
    [],
  );

  const setSelectedMultipleServersToAllServers = useCallback(() => {
    const connectedNames = Object.entries(appState.servers)
      .filter(([, s]) => isConnectedStatus(s.connectionStatus))
      .map(([name]) => name);
    dispatch({ type: "SET_MULTI_SELECTED", names: connectedNames });
  }, [appState.servers, dispatch]);

  const syncServerToConvex = useCallback(
    async (
      serverName: string,
      serverEntry: ServerWithName,
    ): Promise<string | undefined> => {
      if (useLocalFallback || !isAuthenticated || !effectiveActiveWorkspaceId) {
        return undefined;
      }

      const existingServer = activeWorkspaceServersFlat?.find(
        (s) => s.name === serverName,
      );

      const config = serverEntry.config as any;
      const transportType = config?.command ? "stdio" : "http";
      const url =
        config?.url instanceof URL ? config.url.href : config?.url || undefined;
      const headers = config?.requestInit?.headers || undefined;

      const payload = {
        name: serverName,
        enabled: serverEntry.enabled ?? false,
        transportType,
        command: config?.command,
        args: config?.args,
        url,
        headers,
        timeout: config?.timeout,
        useOAuth: serverEntry.useOAuth,
        oauthScopes: serverEntry.oauthFlowProfile?.scopes
          ? serverEntry.oauthFlowProfile.scopes.split(",").filter(Boolean)
          : undefined,
        clientId: serverEntry.oauthFlowProfile?.clientId,
      } as const;

      try {
        if (existingServer) {
          await convexUpdateServer({
            serverId: existingServer._id,
            ...payload,
          });
          return existingServer._id;
        }

        const newId = await convexCreateServer({
          workspaceId: effectiveActiveWorkspaceId,
          ...payload,
        });
        return newId as string | undefined;
      } catch (primaryError) {
        // Best-effort fallback for stale query snapshots:
        // if update failed, try create; if create failed, try update when possible.
        try {
          if (existingServer) {
            const newId = await convexCreateServer({
              workspaceId: effectiveActiveWorkspaceId,
              ...payload,
            });
            return newId as string | undefined;
          }
          const retryExisting = activeWorkspaceServersFlat?.find(
            (s) => s.name === serverName,
          );
          if (retryExisting) {
            await convexUpdateServer({
              serverId: retryExisting._id,
              ...payload,
            });
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
      useLocalFallback,
      isAuthenticated,
      effectiveActiveWorkspaceId,
      activeWorkspaceServersFlat,
      convexUpdateServer,
      convexCreateServer,
      logger,
    ],
  );

  const removeServerFromConvex = useCallback(
    async (serverName: string) => {
      if (useLocalFallback || !isAuthenticated || !effectiveActiveWorkspaceId) {
        return;
      }

      const existingServer = activeWorkspaceServersFlat?.find(
        (s) => s.name === serverName,
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
      effectiveActiveWorkspaceId,
      activeWorkspaceServersFlat,
      convexDeleteServer,
      logger,
    ],
  );

  const persistServerToLocalWorkspace = useCallback(
    (
      serverName: string,
      serverEntry: ServerWithName,
      options?: { originalServerName?: string },
    ) => {
      const targetWorkspaceId =
        effectiveActiveWorkspaceId !== "none"
          ? effectiveActiveWorkspaceId
          : appState.activeWorkspaceId;

      if (!targetWorkspaceId || targetWorkspaceId === "none") {
        return;
      }

      const workspace =
        effectiveWorkspaces[targetWorkspaceId] ??
        appState.workspaces[targetWorkspaceId];
      if (!workspace) {
        return;
      }

      const nextServers = { ...workspace.servers };
      if (
        options?.originalServerName &&
        options.originalServerName !== serverName
      ) {
        delete nextServers[options.originalServerName];
      }
      nextServers[serverName] = serverEntry;

      dispatch({
        type: "UPDATE_WORKSPACE",
        workspaceId: targetWorkspaceId,
        updates: { servers: nextServers },
      });
    },
    [
      effectiveActiveWorkspaceId,
      effectiveWorkspaces,
      appState.activeWorkspaceId,
      appState.workspaces,
      dispatch,
    ],
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
    [dispatch],
  );

  /**
   * Stores init info from an inline connection result, or falls back to
   * fetching it via a separate request. Callers can fire-and-forget (no await)
   * or await depending on whether they need it resolved before continuing.
   */
  const storeInitInfo = useCallback(
    async (
      serverName: string,
      initInfo: Record<string, unknown> | null | undefined,
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
    [dispatch, fetchAndStoreInitInfo],
  );

  const completeConnection = useCallback(
    async (
      serverName: string,
      serverConfig: MCPServerConfig,
      result: ConnectionApiResponse,
      options?: {
        tokens?: ReturnType<typeof getStoredTokens>;
        useOAuth?: boolean;
        successToast?: string;
        failureToast?: string;
      },
    ): Promise<boolean> => {
      if (result.success) {
        dispatch({
          type: "CONNECT_SUCCESS",
          name: serverName,
          config: serverConfig,
          ...(options?.tokens ? { tokens: options.tokens } : {}),
          ...(options?.useOAuth !== undefined
            ? { useOAuth: options.useOAuth }
            : {}),
          ...(result.report ? { report: result.report } : {}),
        });
        await storeInitInfo(
          serverName,
          result.report?.initInfo ?? result.initInfo,
        );
        if (options?.successToast) {
          toast.success(options.successToast);
        }
        return true;
      }

      const errorMessage = getConnectionErrorMessage(result);
      dispatch({
        type: "CONNECT_FAILURE",
        name: serverName,
        error: errorMessage,
        ...(result.report ? { report: result.report } : {}),
      });
      if (options?.failureToast) {
        toast.error(options.failureToast.replace("{error}", errorMessage));
      }
      return false;
    },
    [dispatch, getConnectionErrorMessage, storeInitInfo],
  );

  const resolveOAuthInitiationInputs = useCallback(
    async (
      formData: ServerFormData,
    ): Promise<ResolvedOAuthInitiationInputs> => {
      let registryOAuthConfig: RegistryOAuthConfigResponse | null = null;

      if (formData.registryServerId) {
        try {
          registryOAuthConfig = (await convex.query(
            "registryServers:getRegistryServerOAuthConfig" as any,
            { registryServerId: formData.registryServerId } as any,
          )) as RegistryOAuthConfigResponse | null;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          throw new Error(
            `Failed to resolve registry OAuth config: ${errorMessage}`,
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
          (scope): scope is string => typeof scope === "string",
        )
          ? registryOAuthConfig.scopes
          : formData.oauthScopes;

      return {
        clientId,
        clientSecret: formData.clientSecret,
        registryServerId: formData.registryServerId,
        scopes,
        useRegistryOAuthProxy:
          formData.useRegistryOAuthProxy === true ||
          Boolean(clientId && formData.registryServerId),
      };
    },
    [convex],
  );

  const handleOAuthCallbackComplete = useCallback(
    async (
      code: string,
      hostedCallbackContext: ReturnType<typeof getHostedOAuthCallbackContext>,
    ) => {
      const pendingServerName = localStorage.getItem("mcp-oauth-pending");
      const isHostedWorkspaceCallback =
        HOSTED_MODE &&
        isAuthenticated &&
        hostedCallbackContext?.surface === "workspace";

      try {
        const result = isHostedWorkspaceCallback
          ? await completeHostedOAuthCallback(hostedCallbackContext, code)
          : await handleOAuthCallback(code);

        localStorage.removeItem("mcp-oauth-return-hash");
        if (isHostedWorkspaceCallback) {
          clearHostedOAuthPendingState();
          localStorage.removeItem("mcp-oauth-pending");
        }

        if (result.success && result.serverConfig && result.serverName) {
          const serverName = result.serverName;

          dispatch({
            type: "CONNECT_REQUEST",
            name: serverName,
            config: result.serverConfig,
            select: true,
          });

          try {
            const oauthContext = buildOAuthContext({ serverName });
            const connectionResult = await guardedTestConnection(
              withWorkspaceClientCapabilities(result.serverConfig),
              serverName,
              oauthContext,
            );
            if (
              await completeConnection(
                serverName,
                result.serverConfig,
                connectionResult,
                {
                  tokens: isHostedWorkspaceCallback
                    ? undefined
                    : getStoredTokens(serverName),
                  useOAuth: true,
                },
              )
            ) {
              logger.info("OAuth connection successful", { serverName });
              toast.success(
                `OAuth connection successful! Connected to ${serverName}.`,
              );
            } else {
              logger.error("OAuth connection test failed", {
                serverName,
                error: getConnectionErrorMessage(connectionResult),
              });
              toast.error(
                `OAuth succeeded but connection test failed: ${getConnectionErrorMessage(connectionResult)}`,
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
            });
            logger.error("OAuth connection test error", {
              serverName,
              error: errorMessage,
            });
            toast.error(
              `OAuth succeeded but connection test failed: ${errorMessage}`,
            );
          }
        } else {
          throw new Error(result.error || "OAuth callback failed");
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Error completing OAuth flow: ${errorMessage}`);
        logger.error("OAuth callback failed", { error: errorMessage });
        const failedServerName =
          failPendingOAuthConnection(errorMessage) ?? pendingServerName;
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
      buildOAuthContext,
      completeConnection,
      failPendingOAuthConnection,
      getConnectionErrorMessage,
      isAuthenticated,
      logger,
      guardedTestConnection,
      withWorkspaceClientCapabilities,
    ],
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
      (isLoadingWorkspaces || !effectiveActiveWorkspaceId)
    ) {
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const error = urlParams.get("error");
    const errorDescription = urlParams.get("error_description");
    const hostedOAuthCallbackContext = HOSTED_MODE
      ? getHostedOAuthCallbackContext()
      : null;
    const isHostedWorkspaceCallback =
      hostedOAuthCallbackContext?.surface === "workspace";
    if (code) {
      if (hostedOAuthCallbackContext && !isHostedWorkspaceCallback) {
        return; // Handled by App.tsx hosted OAuth interception
      }
      if (oauthCallbackHandledRef.current) {
        return;
      }
      oauthCallbackHandledRef.current = true;

      const savedHash = localStorage.getItem("mcp-oauth-return-hash") || "";
      window.history.replaceState(
        {},
        document.title,
        restorePathAfterOAuthCallback(window.location.pathname, savedHash),
      );

      handleOAuthCallbackComplete(
        code,
        isHostedWorkspaceCallback ? hostedOAuthCallbackContext : null,
      );
    } else if (error) {
      if (hostedOAuthCallbackContext && !isHostedWorkspaceCallback) {
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
        restorePathAfterOAuthCallback(window.location.pathname, savedHash),
      );
    }
  }, [
    isLoading,
    isAuthLoading,
    isAuthenticated,
    useLocalFallback,
    isLoadingWorkspaces,
    effectiveActiveWorkspaceId,
    failPendingOAuthConnection,
    handleOAuthCallbackComplete,
    logger,
  ]);

  const handleConnect = useCallback(
    async (
      formData: ServerFormData,
      options?: { oauthProfile?: OAuthTestProfile },
    ) => {
      if (notifyIfClientConfigSyncPending()) {
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

      const serverEntryForSave: ServerWithName = {
        name: formData.name,
        config: mcpConfig,
        lastConnectionTime: new Date(),
        connectionStatus: "connecting",
        retryCount: 0,
        enabled: true,
        useOAuth: formData.useOAuth ?? false,
      };
      if (HOSTED_MODE) {
        try {
          const serverId = await syncServerToConvex(
            formData.name,
            serverEntryForSave,
          );
          if (serverId) {
            hostedServerId = serverId;
            injectHostedServerMapping(formData.name, serverId);
          }
        } catch (err) {
          logger.warn("Sync to Convex failed (pre-connection)", {
            serverName: formData.name,
            err,
          });
        }
      } else {
        syncServerToConvex(formData.name, serverEntryForSave).catch((err) =>
          logger.warn("Background sync to Convex failed (pre-connection)", {
            serverName: formData.name,
            err,
          }),
        );
      }
      if (!isAuthenticated) {
        const workspace = appState.workspaces[appState.activeWorkspaceId];
        if (workspace) {
          dispatch({
            type: "UPDATE_WORKSPACE",
            workspaceId: appState.activeWorkspaceId,
            updates: {
              servers: {
                ...workspace.servers,
                [formData.name]: serverEntryForSave,
              },
            },
          });
        }
      }

      saveOAuthConfigToLocalStorage(formData, {
        oauthProfile: options?.oauthProfile,
        preserveExistingConfigFrom: formData.name,
      });

      try {
        if (formData.type === "http" && formData.useOAuth && formData.url) {
          const oauthContext = buildOAuthContext({
            serverName: formData.name,
            oauthProfile: options?.oauthProfile,
            usedCustomClientCredentials:
              Boolean(formData.clientId?.trim()) ||
              Boolean(formData.clientSecret?.trim()),
          });
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
              withWorkspaceClientCapabilities(serverConfig),
              formData.name,
              oauthContext,
            );
            if (isStaleOp(formData.name, token)) return;
            if (
              await completeConnection(
                formData.name,
                serverConfig,
                connectionResult,
                { tokens: existingTokens, useOAuth: true },
              )
            ) {
              toast.success(
                "Connected successfully with existing OAuth tokens!",
              );
              return;
            }
            logger.warn("Existing tokens failed, will trigger OAuth flow", {
              serverName: formData.name,
              error: getConnectionErrorMessage(connectionResult),
            });
          }

          dispatch({
            type: "UPSERT_SERVER",
            name: formData.name,
            server: {
              name: formData.name,
              config: mcpConfig,
              lastConnectionTime: new Date(),
              connectionStatus: "oauth-flow",
              retryCount: 0,
              enabled: true,
              useOAuth: true,
            } as ServerWithName,
          });

          const oauthInputs = await resolveOAuthInitiationInputs(formData);
          saveOAuthConfigToLocalStorage(formData, {
            oauthProfile: options?.oauthProfile,
            useRegistryOAuthProxy: oauthInputs.useRegistryOAuthProxy,
          });
          const oauthOptions: any = {
            serverName: formData.name,
            serverUrl: formData.url,
            clientId: oauthInputs.clientId,
            clientSecret: oauthInputs.clientSecret,
            registryServerId: oauthInputs.registryServerId,
            useRegistryOAuthProxy: oauthInputs.useRegistryOAuthProxy,
            protocolVersion: options?.oauthProfile?.protocolVersion,
            registrationStrategy: options?.oauthProfile?.registrationStrategy,
          };
          if (oauthInputs.scopes && oauthInputs.scopes.length > 0) {
            oauthOptions.scopes = oauthInputs.scopes;
          }
          prepareHostedWorkspaceOAuthRedirect({
            serverId: hostedServerId,
            serverName: formData.name,
            serverUrl: formData.url,
          });
          const oauthResult = await initiateOAuth(oauthOptions);
          if (oauthResult.success) {
            if (oauthResult.serverConfig) {
              const connectionResult = await guardedTestConnection(
                withWorkspaceClientCapabilities(oauthResult.serverConfig),
                formData.name,
                oauthContext,
              );
              if (isStaleOp(formData.name, token)) return;
              if (
                await completeConnection(
                  formData.name,
                  oauthResult.serverConfig,
                  connectionResult,
                  {
                    tokens:
                      HOSTED_MODE && isAuthenticated
                        ? undefined
                        : getStoredTokens(formData.name),
                    useOAuth: true,
                  },
                )
              ) {
                toast.success("Connected successfully with OAuth!");
              } else {
                toast.error(
                  `OAuth succeeded but connection failed: ${getConnectionErrorMessage(connectionResult)}`,
                );
              }
            } else {
              toast.success(
                "OAuth flow initiated. You will be redirected to authorize access.",
              );
            }
            return;
          }

          if (isStaleOp(formData.name, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name: formData.name,
            error: oauthResult.error || "OAuth initialization failed",
          });
          toast.error(`OAuth initialization failed: ${oauthResult.error}`);
          return;
        }

        const hasPendingCallback = new URLSearchParams(
          window.location.search,
        ).has("code");
        if (!hasPendingCallback) {
          clearOAuthData(formData.name);
        }
        const effectiveConfig = withWorkspaceClientCapabilities(mcpConfig);
        const result = await guardedTestConnection(
          effectiveConfig,
          formData.name,
          buildOAuthContext({
            serverName: formData.name,
            oauthProfile: options?.oauthProfile,
            usedCustomClientCredentials:
              Boolean(formData.clientId?.trim()) ||
              Boolean(formData.clientSecret?.trim()),
          }),
        );
        if (isStaleOp(formData.name, token)) return;
        if (
          await completeConnection(formData.name, mcpConfig, result, {
            useOAuth: formData.useOAuth ?? false,
          })
        ) {
          const env = (mcpConfig as any).env;
          if (env && Object.keys(env).length > 0) {
            localStorage.setItem(
              `mcp-env-${formData.name}`,
              JSON.stringify(env),
            );
          }
          logger.info("Connection successful", { serverName: formData.name });
          if (
            !shouldSuppressExcalidrawConnectToastForOnboarding(formData.name)
          ) {
            toast.success("Connected successfully!");
          }
        } else {
          logger.error("Connection failed", {
            serverName: formData.name,
            error: getConnectionErrorMessage(result),
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
        toast.error(`Network error: ${errorMessage}`);
      }
    },
    [
      dispatch,
      isAuthenticated,
      appState.workspaces,
      appState.activeWorkspaceId,
      notifyIfClientConfigSyncPending,
      prepareHostedWorkspaceOAuthRedirect,
      resolveOAuthInitiationInputs,
      syncServerToConvex,
      logger,
      buildOAuthContext,
      completeConnection,
      getConnectionErrorMessage,
      guardedTestConnection,
      withWorkspaceClientCapabilities,
    ],
  );

  const saveServerConfigWithoutConnecting = useCallback(
    async (
      formData: ServerFormData,
      options?: { oauthProfile?: OAuthTestProfile },
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
        ? (options?.oauthProfile ?? existingServer?.oauthFlowProfile)
        : undefined;

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
      } as ServerWithName;

      const hasPendingOAuthCallback = new URLSearchParams(
        window.location.search,
      ).has("code");
      if (!formData.useOAuth && !hasPendingOAuthCallback) {
        clearOAuthData(serverName);
      }

      dispatch({
        type: "UPSERT_SERVER",
        name: serverName,
        server: serverEntry,
      });

      saveOAuthConfigToLocalStorage(formData, {
        oauthProfile: options?.oauthProfile,
        preserveExistingConfigFrom: formData.name,
      });

      if (
        isAuthenticated &&
        !useLocalFallback &&
        effectiveActiveWorkspaceId &&
        effectiveActiveWorkspaceId !== "none"
      ) {
        try {
          await syncServerToConvex(serverName, serverEntry);
        } catch (error) {
          logger.error("Failed to sync server to Convex", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } else {
        persistServerToLocalWorkspace(serverName, serverEntry);
      }

      logger.info("Saved server configuration without connecting", {
        serverName,
      });
      toast.success(`Saved configuration for ${serverName}`);
    },
    [
      appState.activeWorkspaceId,
      appState.servers,
      appState.workspaces,
      logger,
      dispatch,
      isAuthenticated,
      useLocalFallback,
      effectiveActiveWorkspaceId,
      syncServerToConvex,
      persistServerToLocalWorkspace,
    ],
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
      serverUrl: string,
    ): Promise<{ success: boolean; error?: string }> => {
      const tokenData = {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType || "Bearer",
        expires_in: tokens.expiresIn,
      };
      localStorage.setItem(
        `mcp-tokens-${serverName}`,
        JSON.stringify(tokenData),
      );

      if (tokens.clientId) {
        localStorage.setItem(
          `mcp-client-${serverName}`,
          JSON.stringify({
            client_id: tokens.clientId,
            client_secret: tokens.clientSecret,
          }),
        );
      }

      localStorage.setItem(`mcp-serverUrl-${serverName}`, serverUrl);

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
        const oauthContext = buildOAuthContext({
          serverName,
          usedCustomClientCredentials:
            Boolean(tokens.clientId) || Boolean(tokens.clientSecret),
        });
        const result = await guardedReconnectServer(
          serverName,
          withWorkspaceClientCapabilities(serverConfig),
          oauthContext,
        );
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        if (
          await completeConnection(serverName, serverConfig, result, {
            tokens: getStoredTokens(serverName),
            useOAuth: true,
          })
        ) {
          return { success: true };
        }
        return { success: false, error: getConnectionErrorMessage(result) };
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
      buildOAuthContext,
      completeConnection,
      getConnectionErrorMessage,
      guardedReconnectServer,
      withWorkspaceClientCapabilities,
    ],
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
      serverUrl: string,
    ) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }

      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl,
      );
      if (result.success) {
        toast.success(`Connected to ${serverName}!`);
      } else {
        toast.error(`Connection failed: ${result.error}`);
      }
    },
    [applyTokensFromOAuthFlow, notifyIfClientConfigSyncPending],
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
      serverUrl: string,
    ) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }

      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl,
      );
      if (result.success) {
        toast.success(`Tokens refreshed for ${serverName}!`);
      } else {
        toast.error(`Token refresh failed: ${result.error}`);
      }
    },
    [applyTokensFromOAuthFlow, notifyIfClientConfigSyncPending],
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
                },
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
    [appState.servers],
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
    [dispatch, logger],
  );

  const cleanupServerLocalArtifacts = useCallback((serverName: string) => {
    clearOAuthData(serverName);
    localStorage.removeItem(`mcp-env-${serverName}`);
  }, []);

  const removeServerFromStateAndCloud = useCallback(
    async (serverName: string) => {
      cleanupServerLocalArtifacts(serverName);
      dispatch({ type: "REMOVE_SERVER", name: serverName });
      await removeServerFromConvex(serverName);
    },
    [cleanupServerLocalArtifacts, dispatch, removeServerFromConvex],
  );

  const handleRemoveServer = useCallback(
    async (serverName: string) => {
      logger.info("Removing server", { serverName });
      await handleDisconnect(serverName);
      await removeServerFromStateAndCloud(serverName);
    },
    [logger, handleDisconnect, removeServerFromStateAndCloud],
  );

  const handleReconnect = useCallback(
    async (serverName: string, options?: { forceOAuthFlow?: boolean }) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }

      logger.info("Reconnecting to server", { serverName, options });
      const server = effectiveServers[serverName];
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
        toast.error(errorMessage);
        return;
      }

      dispatch({
        type: "RECONNECT_REQUEST",
        name: serverName,
        config: server.config,
      });
      const token = nextOpToken(serverName);
      const oauthContext = buildOAuthContext({
        serverName,
        oauthProfile: server.oauthFlowProfile,
        usedCustomClientCredentials: Boolean(
          server.oauthFlowProfile?.clientId?.trim() ||
          server.oauthFlowProfile?.clientSecret?.trim(),
        ),
      });
      const hostedWorkspaceServerId = activeWorkspaceServersFlat?.find(
        (remoteServer) => remoteServer.name === serverName,
      )?._id;

      if (options?.forceOAuthFlow) {
        const serverUrl = (server.config as any)?.url?.toString?.();
        if (!serverUrl) {
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: "No server URL found for OAuth flow",
          });
          return;
        }

        prepareHostedWorkspaceOAuthRedirect({
          serverId: hostedWorkspaceServerId,
          serverName,
          serverUrl,
        });
        const reconnectOAuthOptions = buildReconnectOAuthOptions(
          serverName,
          server,
          serverUrl,
        );
        clearOAuthData(serverName);
        await deleteServer(serverName);

        const oauthResult = await initiateOAuth(reconnectOAuthOptions);

        if (oauthResult.success && !oauthResult.serverConfig) {
          return;
        }
        if (!oauthResult.success) {
          if (isStaleOp(serverName, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: oauthResult.error || "OAuth flow failed",
          });
          toast.error(`OAuth failed: ${serverName}`);
          return;
        }
        const result = await guardedReconnectServer(
          serverName,
          withWorkspaceClientCapabilities(oauthResult.serverConfig!),
          oauthContext,
        );
        if (isStaleOp(serverName, token)) return;
        if (
          await completeConnection(
            serverName,
            oauthResult.serverConfig!,
            result,
            {
              tokens:
                HOSTED_MODE && isAuthenticated
                  ? undefined
                  : getStoredTokens(serverName),
              useOAuth: true,
            },
          )
        ) {
          logger.info("Reconnection with fresh OAuth successful", {
            serverName,
          });
          return;
        }
        return;
      }

      if (HOSTED_MODE && isAuthenticated && server.useOAuth === true) {
        const hostedReconnectConfig = withWorkspaceClientCapabilities(
          server.config,
        );
        try {
          const result = await guardedReconnectServer(
            serverName,
            hostedReconnectConfig,
          );
          if (isStaleOp(serverName, token)) return;
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
              logger.warn("Failed to fetch init info", { serverName, err }),
            );
            return;
          }

          if (!requiresFreshOAuthAuthorization(result.error)) {
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: result.error || "Reconnection failed",
            });
            logger.error("Hosted reconnect failed", { serverName, result });
            toast.error(result.error || `Failed to reconnect: ${serverName}`);
            return;
          }

          logger.info(
            "Hosted reconnect requires a fresh OAuth flow after stored credential lookup",
            { serverName, error: result.error },
          );
        } catch (error) {
          if (isStaleOp(serverName, token)) return;

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
            toast.error(errorMessage || `Failed to reconnect: ${serverName}`);
            return;
          }

          logger.info(
            "Hosted reconnect requires a fresh OAuth flow after stored credential lookup",
            { serverName, error: errorMessage },
          );
        }
      }

      try {
        const authResult: OAuthResult = await ensureAuthorizedForReconnect(
          server,
          {
            beforeRedirect: (oauthOptions) => {
              prepareHostedWorkspaceOAuthRedirect({
                serverId: hostedWorkspaceServerId,
                serverName,
                serverUrl: oauthOptions.serverUrl,
              });
            },
          },
        );
        if (authResult.kind === "redirect") return;
        if (authResult.kind === "error") {
          if (isStaleOp(serverName, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: authResult.error,
          });
          toast.error(`Failed to connect: ${serverName}`);
          return;
        }
        const result = await guardedReconnectServer(
          serverName,
          withWorkspaceClientCapabilities(authResult.serverConfig),
          oauthContext,
        );
        if (isStaleOp(serverName, token)) return;
        if (
          await completeConnection(
            serverName,
            authResult.serverConfig,
            result,
            {
              tokens: authResult.tokens,
              useOAuth: server.useOAuth === true || authResult.tokens != null,
            },
          )
        ) {
          logger.info("Reconnection successful", { serverName, result });
          return;
        }
        logger.error("Reconnection failed", { serverName, result });
        const errorMessage =
          getConnectionErrorMessage(result) ||
          `Failed to reconnect: ${serverName}`;
        toast.error(errorMessage);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(serverName, token)) return;
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        logger.error("Reconnection failed", {
          serverName,
          error: errorMessage,
        });
      }
    },
    [
      activeWorkspaceServersFlat,
      isAuthenticated,
      effectiveServers,
      logger,
      dispatch,
      buildReconnectOAuthOptions,
      notifyIfClientConfigSyncPending,
      buildOAuthContext,
      completeConnection,
      getConnectionErrorMessage,
      prepareHostedWorkspaceOAuthRedirect,
      guardedReconnectServer,
      withWorkspaceClientCapabilities,
    ],
  );

  useEffect(() => {
    if (isLoading) return;
    const syncServerStatus = async () => {
      try {
        const result = await listServers();
        if (result?.success && result.servers) {
          dispatch({ type: "SYNC_AGENT_STATUS", servers: result.servers });
        }
      } catch (error) {
        logger.debug("Failed to sync server status on startup", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };
    syncServerStatus();
  }, [isLoading, logger, dispatch]);

  const setSelectedServer = useCallback(
    (serverName: string) => {
      dispatch({ type: "SELECT_SERVER", name: serverName });
    },
    [dispatch],
  );

  const setSelectedMCPConfigs = useCallback(
    (serverNames: string[]) => {
      dispatch({ type: "SET_MULTI_SELECTED", names: serverNames });
    },
    [dispatch],
  );

  const toggleMultiSelectMode = useCallback(
    (enabled: boolean) => {
      dispatch({ type: "SET_MULTI_MODE", enabled });
    },
    [dispatch],
  );

  const toggleServerSelection = useCallback(
    (serverName: string) => {
      const current = appState.selectedMultipleServers;
      const next = current.includes(serverName)
        ? current.filter((n) => n !== serverName)
        : [...current, serverName];
      dispatch({ type: "SET_MULTI_SELECTED", names: next });
    },
    [appState.selectedMultipleServers, dispatch],
  );

  const handleUpdate = useCallback(
    async (
      originalServerName: string,
      formData: ServerFormData,
      skipAutoConnect?: boolean,
      options?: { oauthProfile?: OAuthTestProfile },
    ): Promise<ServerUpdateResult> => {
      const nextServerName = formData.name.trim();
      if (!nextServerName) {
        toast.error("Server name is required");
        return { ok: false, serverName: originalServerName };
      }
      const isRename = nextServerName !== originalServerName;
      const activeWorkspaceServers =
        effectiveWorkspaces[effectiveActiveWorkspaceId]?.servers ?? {};
      if (isRename && activeWorkspaceServers[nextServerName]) {
        toast.error(
          `A server named "${nextServerName}" already exists. Choose a different name.`,
        );
        return { ok: false, serverName: originalServerName };
      }
      const originalServer =
        appState.servers[originalServerName] ??
        effectiveServers[originalServerName];

      if (skipAutoConnect) {
        const mcpConfig = toMCPConfig(formData);
        const nextOAuthProfile = formData.useOAuth
          ? (options?.oauthProfile ?? originalServer?.oauthFlowProfile)
          : undefined;
        if (isRename && formData.useOAuth) {
          saveOAuthConfigToLocalStorage(formData, {
            oauthProfile: nextOAuthProfile,
            preserveExistingConfigFrom: originalServerName,
          });
        }
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
          oauthFlowProfile: nextOAuthProfile,
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
          persistServerToLocalWorkspace(nextServerName, updatedServer, {
            originalServerName: isRename ? originalServerName : undefined,
          });
        } else {
          await syncServerToConvex(nextServerName, updatedServer);
        }

        saveOAuthConfigToLocalStorage(formData, {
          oauthProfile: updatedServer.oauthFlowProfile,
          preserveExistingConfigFrom: nextServerName,
        });
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
        saveOAuthConfigToLocalStorage(formData, {
          oauthProfile:
            options?.oauthProfile ?? originalServer.oauthFlowProfile,
          preserveExistingConfigFrom: originalServerName,
        });
        try {
          const result = await guardedTestConnection(
            withWorkspaceClientCapabilities(mcpConfig),
            originalServerName,
            buildOAuthContext({
              serverName: originalServerName,
              oauthProfile:
                options?.oauthProfile ?? originalServer.oauthFlowProfile,
              usedCustomClientCredentials: Boolean(
                options?.oauthProfile?.clientId?.trim() ||
                originalServer.oauthTokens?.client_id,
              ),
            }),
          );
          if (
            await completeConnection(originalServerName, mcpConfig, result, {
              useOAuth: true,
            })
          ) {
            toast.success("Server configuration updated successfully!");
            return { ok: true, serverName: originalServerName };
          }
          console.warn(
            "OAuth connection test failed, falling back to full reconnect",
          );
        } catch (error) {
          console.warn(
            "OAuth connection test error, falling back to full reconnect",
            error,
          );
        }
      }

      if (hadOAuthTokens && !formData.useOAuth) {
        clearOAuthData(originalServerName);
      }

      saveOAuthConfigToLocalStorage(formData, {
        oauthProfile: options?.oauthProfile ?? originalServer?.oauthFlowProfile,
        preserveExistingConfigFrom: originalServerName,
      });

      if (isRename) {
        await handleDisconnect(originalServerName);
        await removeServerFromStateAndCloud(originalServerName);
      } else {
        await handleDisconnect(originalServerName);
      }
      await handleConnect(formData, {
        oauthProfile: options?.oauthProfile ?? originalServer?.oauthFlowProfile,
      });
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
      appState.activeWorkspaceId,
      appState.workspaces,
      appState.selectedServer,
      dispatch,
      effectiveWorkspaces,
      effectiveActiveWorkspaceId,
      effectiveServers,
      handleDisconnect,
      handleConnect,
      isAuthenticated,
      removeServerFromStateAndCloud,
      setSelectedServer,
      syncServerToConvex,
      useLocalFallback,
      persistServerToLocalWorkspace,
      notifyIfClientConfigSyncPending,
      buildOAuthContext,
      completeConnection,
      guardedTestConnection,
    ],
  );

  return {
    activeWorkspace,
    effectiveServers,
    workspaceServers: effectiveServers,
    connectedOrConnectingServerConfigs: Object.fromEntries(
      Object.entries(effectiveServers).filter(
        ([, server]) =>
          isConnectedStatus(server.connectionStatus) ||
          server.connectionStatus === "connecting",
      ),
    ),
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
      {} as Record<string, MCPServerConfig>,
    ),
    isMultiSelectMode: appState.isMultiSelectMode,
    handleConnect,
    handleDisconnect,
    handleReconnect,
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
  };
}
