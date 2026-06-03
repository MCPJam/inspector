import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { useConvexAuth, useQuery } from "convex/react";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { useLogger } from "./use-logger";
import { useHost } from "./useClients";
import { usePreviewedHostId } from "./use-previewed-client-id";
import { resolveEffectiveHost } from "@/lib/effective-client";
import {
  createLocalDefaultProject,
  initialAppState,
  type AppState,
  type ServerWithName,
} from "@/state/app-types";
import { appReducer } from "@/state/app-reducer";
import { disconnectAllRuntimeServers } from "@/state/mcp-api";
import { useProjectState } from "./use-project-state";
import { useServerState } from "./use-server-state";
import {
  clearLegacyActiveOrganizationStorage,
  readStoredActiveOrganizationId,
  writeStoredActiveOrganizationId,
} from "@/lib/active-organization-storage";
import {
  clearHostedOAuthPendingState,
  HOSTED_OAUTH_PENDING_STORAGE_KEY,
} from "@/lib/hosted-oauth-callback";
import { clearPendingQuickConnect } from "@/lib/quick-connect-pending";
import { shouldQueryProjectId } from "./useProjects";
import { HOSTED_MODE } from "@/lib/config";

export type { ServerWithName } from "@/state/app-types";
export type {
  EnsureServersReadyResult,
  ServerUpdateResult,
  PersistRuntimeServerResult,
} from "./use-server-state";

export interface PendingDashboardOAuthState {
  serverName: string;
  serverUrl: string | null;
  startedAt: number;
}

const PENDING_DASHBOARD_OAUTH_UI_TIMEOUT_MS = 30 * 1000;

interface ActiveOrganizationSelection {
  organizationId?: string;
  userId: string | null;
}

function resolveFallbackOrganizationId(
  organizations: ReadonlyArray<{ _id: string; myRole?: string }>
) {
  const firstOwnedOrganization = organizations.find(
    (organization) => organization.myRole === "owner"
  );

  return firstOwnedOrganization?._id ?? organizations[0]?._id;
}

function createDefaultProject() {
  return createLocalDefaultProject();
}

function hasHostedOAuthCallbackParams(): boolean {
  if (typeof window === "undefined") return false;
  // WorkOS sign-in lands on /callback?code=…; MCP server OAuth lands on
  // /oauth/callback?code=…. Without this path scope a WorkOS sign-in is
  // misread as an in-flight MCP OAuth callback, resurfacing a stale
  // "Finishing OAuth sign-in for X…" gate from leftover localStorage markers.
  const pathname = window.location.pathname;
  if (pathname !== "/oauth/callback" && !pathname.startsWith("/oauth/callback/")) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.has("code") || params.has("error");
}

// Reads the organizationId from an in-flight project-surface OAuth marker.
// Used to keep the active org stable across the post-callback re-mount,
// avoiding a hydration-window flip to resolveFallbackOrganizationId.
function readPendingOAuthMarkerOrgId(): string | null {
  if (typeof window === "undefined") return null;
  if (!hasHostedOAuthCallbackParams()) return null;
  try {
    const raw = localStorage.getItem(HOSTED_OAUTH_PENDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      surface?: unknown;
      organizationId?: unknown;
    } | null;
    if (parsed?.surface !== "project") return null;
    return typeof parsed.organizationId === "string" && parsed.organizationId
      ? parsed.organizationId
      : null;
  } catch {
    return null;
  }
}

function readPendingDashboardOAuthFromStorage(): PendingDashboardOAuthState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(HOSTED_OAUTH_PENDING_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        serverName?: unknown;
        serverUrl?: unknown;
        startedAt?: unknown;
        surface?: unknown;
      } | null;
      if (parsed?.surface === "chatbox" || parsed?.surface === "shared") {
        return null;
      }
      if (
        parsed?.surface === "project" &&
        typeof parsed.serverName === "string" &&
        parsed.serverName
      ) {
        return {
          serverName: parsed.serverName,
          serverUrl:
            typeof parsed.serverUrl === "string" ? parsed.serverUrl : null,
          startedAt:
            typeof parsed.startedAt === "number"
              ? parsed.startedAt
              : Date.now(),
        };
      }
    }
  } catch {
    // ignore
  }
  const serverName = localStorage.getItem("mcp-oauth-pending");
  if (!serverName) return null;
  return {
    serverName,
    serverUrl: localStorage.getItem(`mcp-serverUrl-${serverName}`),
    startedAt: Date.now(),
  };
}

// Resolves dashboard/server-list OAuth callbacks only. Hosted chatbox/shared
// callbacks are handled by App.tsx and must not affect server-card state.
function readPendingDashboardOAuth(): PendingDashboardOAuthState | null {
  if (!hasHostedOAuthCallbackParams()) return null;
  return readPendingDashboardOAuthFromStorage();
}

function isHistoryRestore(event: PageTransitionEvent): boolean {
  if (event.persisted) return true;

  const navigationEntry = performance.getEntriesByType?.("navigation").at(0) as
    | PerformanceNavigationTiming
    | undefined;
  return navigationEntry?.type === "back_forward";
}

export function buildDisconnectedRuntimeServers(
  servers: Record<string, ServerWithName> | undefined
): Record<string, ServerWithName> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).map(([serverName, server]) => [
      serverName,
      {
        ...server,
        connectionStatus: "disconnected",
      } satisfies ServerWithName,
    ])
  );
}

export function useAppState({
  currentUserId,
  currentActorKey,
  routeOrganizationId,
  hasOrganizations,
  isLoadingOrganizations,
  validOrganizations,
  hostsHubFlagEnabled,
  requestSignIn,
}: {
  currentUserId: string | null;
  /**
   * Stable identifier for the active actor — `currentUserId` for signed-in
   * users, the guest cookie's `guestId` for guests. Used to scope per-actor
   * local storage (e.g. active project id) so selections don't bleed across
   * actors. May be `null` while the actor is still resolving.
   */
  currentActorKey: string | null;
  routeOrganizationId?: string;
  hasOrganizations: boolean;
  isLoadingOrganizations: boolean;
  validOrganizations: Array<{ _id: string; myRole?: string }>;
  /**
   * Hosts-hub feature flag. When off, host queries are skipped and the
   * connection path falls back to the project default (still authoritative
   * via its shadow `projects.clientConfig`).
   */
  hostsHubFlagEnabled: boolean;
  requestSignIn?: () => void | Promise<void>;
}) {
  const logger = useLogger("Connections");
  const [appState, dispatch] = useReducer(appReducer, initialAppState);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingDashboardOAuth, setPendingDashboardOAuth] =
    useState<PendingDashboardOAuthState | null>(null);
  const hasHydratedAppStateRef = useRef(false);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();

  const [activeOrganizationSelection, setActiveOrganizationSelection] =
    useState<ActiveOrganizationSelection>({
      organizationId: undefined,
      userId: currentUserId,
    });
  const [
    hasHydratedStoredActiveOrganization,
    setHasHydratedStoredActiveOrganization,
  ] = useState(false);
  const storedActiveOrganizationId =
    activeOrganizationSelection.userId === currentUserId
      ? activeOrganizationSelection.organizationId
      : undefined;
  const isStoredActiveOrganizationValid =
    !!storedActiveOrganizationId &&
    validOrganizations.some(
      (organization) => organization._id === storedActiveOrganizationId
    );
  const isRouteOrganizationValid =
    !!routeOrganizationId &&
    validOrganizations.some(
      (organization) => organization._id === routeOrganizationId
    );
  const fallbackActiveOrganizationId =
    hasHydratedStoredActiveOrganization &&
    !routeOrganizationId &&
    !isLoadingOrganizations
      ? resolveFallbackOrganizationId(validOrganizations)
      : undefined;
  const pendingOAuthMarkerOrgId = readPendingOAuthMarkerOrgId();
  const isPendingOAuthMarkerOrgValid =
    !!pendingOAuthMarkerOrgId &&
    validOrganizations.some(
      (organization) => organization._id === pendingOAuthMarkerOrgId
    );
  const activeOrganizationId = isStoredActiveOrganizationValid
    ? storedActiveOrganizationId
    : isPendingOAuthMarkerOrgValid
    ? pendingOAuthMarkerOrgId
    : fallbackActiveOrganizationId;
  const setActiveOrganizationId = useCallback(
    (organizationId: string | undefined) => {
      setActiveOrganizationSelection({
        organizationId,
        userId: currentUserId,
      });
    },
    [currentUserId]
  );

  useEffect(() => {
    clearLegacyActiveOrganizationStorage();
    setHasHydratedStoredActiveOrganization(false);
    setActiveOrganizationSelection({
      organizationId: readStoredActiveOrganizationId(currentUserId),
      userId: currentUserId,
    });
    setHasHydratedStoredActiveOrganization(true);
  }, [currentUserId]);

  const isFirstScopedOrgRender = useRef(true);
  useEffect(() => {
    if (!hasHydratedStoredActiveOrganization) {
      return;
    }
    if (activeOrganizationSelection.userId !== currentUserId) {
      return;
    }

    clearLegacyActiveOrganizationStorage();
    if (isFirstScopedOrgRender.current) {
      isFirstScopedOrgRender.current = false;
      return;
    }

    writeStoredActiveOrganizationId(
      currentUserId,
      activeOrganizationSelection.organizationId
    );
  }, [
    activeOrganizationSelection,
    currentUserId,
    hasHydratedStoredActiveOrganization,
  ]);

  useEffect(() => {
    if (!hasHydratedStoredActiveOrganization) {
      return;
    }
    if (activeOrganizationSelection.userId !== currentUserId) {
      return;
    }
    if (!routeOrganizationId || isLoadingOrganizations) {
      return;
    }
    if (!isRouteOrganizationValid) {
      return;
    }
    if (activeOrganizationSelection.organizationId === routeOrganizationId) {
      return;
    }

    setActiveOrganizationSelection({
      organizationId: routeOrganizationId,
      userId: currentUserId,
    });
  }, [
    activeOrganizationSelection.organizationId,
    activeOrganizationSelection.userId,
    currentUserId,
    hasHydratedStoredActiveOrganization,
    isLoadingOrganizations,
    isRouteOrganizationValid,
    routeOrganizationId,
  ]);

  useEffect(() => {
    if (!hasHydratedStoredActiveOrganization) {
      return;
    }
    if (activeOrganizationSelection.userId !== currentUserId) {
      return;
    }
    if (routeOrganizationId || isLoadingOrganizations) {
      return;
    }

    const nextOrganizationId = activeOrganizationId;
    if (activeOrganizationSelection.organizationId === nextOrganizationId) {
      return;
    }

    setActiveOrganizationSelection({
      organizationId: nextOrganizationId,
      userId: currentUserId,
    });
  }, [
    activeOrganizationId,
    activeOrganizationSelection.organizationId,
    activeOrganizationSelection.userId,
    currentUserId,
    hasHydratedStoredActiveOrganization,
    isLoadingOrganizations,
    routeOrganizationId,
  ]);

  useEffect(() => {
    if (hasHydratedAppStateRef.current) return;
    hasHydratedAppStateRef.current = true;

    // State now hydrates from Convex queries via useProjectState + the flat
    // servers query; the legacy localStorage `loadAppState` is gone. We still
    // need to detect a pending dashboard OAuth callback so the dashboard can
    // surface the in-flight connect, and we need to flip isLoading off so
    // dependent gates resolve.
    try {
      // Convex is now the source of truth for projects/servers/state, but
      // pendingDashboardOAuth is a callback-resume marker for the OAuth
      // flow that still lives in localStorage (deferred to Slice 2b). Read
      // it on first paint so a fresh window can resume the in-flight OAuth.
      const pendingOAuth = readPendingDashboardOAuth();
      setPendingDashboardOAuth((current) => {
        if (
          current?.serverName === pendingOAuth?.serverName &&
          current?.serverUrl === pendingOAuth?.serverUrl
        ) {
          return current;
        }
        return pendingOAuth;
      });
      // No `loadAppState` — Convex queries hydrate state. The migration shim
      // (`local-state-migration`) lifts any legacy localStorage projects on
      // first boot and clears them.
    } catch (error) {
      logger.error("Failed to read pending OAuth marker", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  }, [logger]);

  // No `saveAppState` — Convex mutations persist server/project state; UI
  // selection state (selectedServer, multi-select) is intentionally
  // ephemeral.

  useEffect(() => {
    if (!pendingDashboardOAuth) return;
    const pendingServer = appState.servers[pendingDashboardOAuth.serverName];
    if (
      pendingServer?.connectionStatus === "connected" ||
      pendingServer?.connectionStatus === "failed"
    ) {
      setPendingDashboardOAuth(null);
    }
  }, [appState.servers, pendingDashboardOAuth]);

  useEffect(() => {
    if (!pendingDashboardOAuth) return;

    const elapsedMs = Date.now() - pendingDashboardOAuth.startedAt;
    if (elapsedMs >= PENDING_DASHBOARD_OAUTH_UI_TIMEOUT_MS) {
      setPendingDashboardOAuth(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setPendingDashboardOAuth((current) =>
        current?.serverName === pendingDashboardOAuth.serverName &&
        current.startedAt === pendingDashboardOAuth.startedAt
          ? null
          : current
      );
    }, PENDING_DASHBOARD_OAUTH_UI_TIMEOUT_MS - elapsedMs);

    return () => window.clearTimeout(timeoutId);
  }, [pendingDashboardOAuth]);

  useEffect(() => {
    if (!HOSTED_MODE) return;

    const handlePageShow = (event: PageTransitionEvent) => {
      if (!isHistoryRestore(event) || hasHostedOAuthCallbackParams()) {
        return;
      }

      const pendingOAuth = readPendingDashboardOAuthFromStorage();
      if (!pendingOAuth) {
        return;
      }

      clearHostedOAuthPendingState();
      clearPendingQuickConnect();
      localStorage.removeItem("mcp-oauth-pending");
      localStorage.removeItem("mcp-oauth-return-hash");
      setPendingDashboardOAuth(null);

      const pendingServer = appState.servers[pendingOAuth.serverName];
      if (
        pendingServer?.connectionStatus === "connecting" ||
        pendingServer?.connectionStatus === "oauth-flow"
      ) {
        dispatch({
          type: "CONNECT_FAILURE",
          name: pendingOAuth.serverName,
          error: "Authorization was cancelled. Try again.",
        });
      }
    };

    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [appState.servers]);

  const projectState = useProjectState({
    appState,
    dispatch,
    isAuthenticated,
    isAuthLoading,
    hasOrganizations,
    isLoadingOrganizations,
    validOrganizationIds: validOrganizations.map(
      (organization) => organization._id
    ),
    activeOrganizationId,
    routeOrganizationId,
    currentActorKey,
    hasSignedInUser: currentUserId != null,
    logger,
  });

  // Active project default hostConfig DTO. Sourced from Convex so it
  // stays current with edits made in the ClientConfigEditor without a
  // page reload. We pluck `mcpProfile` out and pass it down to
  // useServerState so resolver-path connects can pin clientInfo and
  // supportedProtocolVersions. `skip` when the active project isn't
  // a real Convex project (guest local-mode fallback) — those flows
  // don't have an mcpProfile, so SDK defaults apply.
  const activeSharedProjectId =
    projectState.effectiveProjects[projectState.effectiveActiveProjectId]
      ?.sharedProjectId;
  const activeProjectDefaultHostConfig = useQuery(
    "hostConfigsV2:getProjectDefault" as any,
    activeSharedProjectId
      ? { projectId: activeSharedProjectId as any }
      : "skip",
  ) as HostConfigDtoV2 | null | undefined;

  // Single active-host state, shared with the Servers/Playground/Hosts
  // top-bar preview and the Chat tab's ClientPicker. Picking a host anywhere
  // in the product points every MCP `initialize` and widget `ui/initialize`
  // at the same `HostConfigDtoV2`.
  const [activeHostId, setActiveHostId] = usePreviewedHostId(
    activeSharedProjectId ?? null,
  );
  const { host: selectedHost } = useHost({
    isAuthenticated: isAuthenticated && hostsHubFlagEnabled,
    hostId: activeHostId,
  });
  const activeHost = resolveEffectiveHost({
    explicitHostConfig: selectedHost?.config ?? null,
    projectDefaultHostConfig: activeProjectDefaultHostConfig ?? null,
  });

  const serverState = useServerState({
    appState,
    dispatch,
    isLoading,
    isAuthenticated,
    hasSignedInUser: currentUserId != null,
    isAuthLoading,
    isLoadingProjects: projectState.isLoadingProjects,
    useLocalFallback: projectState.useLocalFallback,
    effectiveProjects: projectState.effectiveProjects,
    effectiveActiveProjectId: projectState.effectiveActiveProjectId,
    activeProjectServersFlat: projectState.activeProjectServersFlat,
    activeMcpProfile: activeHost?.mcpProfile,
    activeHostConfig: activeHost,
    requestSignIn,
    logger,
  });

  const {
    effectiveProjects,
    setConvexActiveProjectId,
    clearConvexActiveProjectSelection,
    useLocalFallback,
    remoteProjects,
    isLoadingRemoteProjects,
    effectiveActiveProjectId,
  } = projectState;
  const { handleDisconnect } = serverState;

  const disconnectRuntimeServersForScopeReset = useCallback(
    (servers: AppState["servers"], reason: string) => {
      const serverNames = Object.keys(servers);

      if (serverNames.length > 0) {
        logger.info("Disconnecting runtime servers before auth scope reset", {
          reason,
          serverNames,
        });
      }

      void Promise.allSettled([
        Promise.allSettled(
          serverNames.map((serverName) => handleDisconnect(serverName)),
        ),
        disconnectAllRuntimeServers(),
      ]);
    },
    [handleDisconnect, logger],
  );

  const previousRuntimeScopeRef = useRef<{
    actorKey: string | null;
    organizationId?: string;
    projectId: string;
  } | null>(null);

  // This intentionally overlaps with App.tsx's pre-sign-out cleanup. That
  // path runs before WorkOS redirects; this effect covers auth/session changes,
  // guest handoffs, org switches, and project switches that happen without a
  // direct logout click.
  useEffect(() => {
    if (!isAuthenticated || useLocalFallback) {
      if (previousRuntimeScopeRef.current) {
        disconnectRuntimeServersForScopeReset(
          appState.servers,
          "leaving-authenticated-scope",
        );
        dispatch({ type: "CLEAR_RUNTIME_STATE" });
      }
      previousRuntimeScopeRef.current = null;
      return;
    }

    const nextScope = {
      actorKey: currentActorKey,
      organizationId: activeOrganizationId,
      projectId: effectiveActiveProjectId,
    };
    const previousScope = previousRuntimeScopeRef.current;
    previousRuntimeScopeRef.current = nextScope;

    if (!previousScope) {
      return;
    }

    if (
      previousScope.actorKey === nextScope.actorKey &&
      previousScope.organizationId === nextScope.organizationId &&
      previousScope.projectId === nextScope.projectId
    ) {
      return;
    }

    disconnectRuntimeServersForScopeReset(
      appState.servers,
      "authenticated-scope-changed",
    );
    dispatch({ type: "CLEAR_RUNTIME_STATE" });
  }, [
    activeOrganizationId,
    appState.servers,
    currentActorKey,
    disconnectRuntimeServersForScopeReset,
    dispatch,
    effectiveActiveProjectId,
    isAuthenticated,
    useLocalFallback,
  ]);

  const handleSwitchProject = useCallback(
    async (projectId: string) => {
      const newProject = effectiveProjects[projectId];
      if (!newProject) {
        toast.error("Project not found");
        return;
      }

      logger.info("Switching to project", {
        projectId,
        name: newProject.name,
      });

      const currentServers = Object.keys(appState.servers);
      for (const serverName of currentServers) {
        const server = appState.servers[serverName];
        if (server.connectionStatus === "connected") {
          logger.info("Disconnecting server before project switch", {
            serverName,
          });
          await handleDisconnect(serverName);
        }
      }

      if (isAuthenticated && !useLocalFallback) {
        setConvexActiveProjectId(projectId);
      } else {
        dispatch({ type: "SWITCH_PROJECT", projectId });
      }
      toast.success(`Switched to project: ${newProject.name}`);
    },
    [
      effectiveProjects,
      appState.servers,
      handleDisconnect,
      logger,
      isAuthenticated,
      useLocalFallback,
      dispatch,
      setConvexActiveProjectId,
    ]
  );

  const handleLeaveProject = useCallback(
    async (projectId: string) => {
      const project = effectiveProjects[projectId];
      if (!project) {
        toast.error("Project not found");
        return;
      }

      const otherProjectIds = Object.keys(effectiveProjects).filter(
        (id) => id !== projectId
      );
      const defaultProject = otherProjectIds.find(
        (id) => effectiveProjects[id].isDefault
      );
      const targetProjectId = defaultProject || otherProjectIds[0];

      if (!targetProjectId) {
        toast.error("Cannot leave the only project");
        return;
      }

      const projectServers = Object.keys(project.servers || {});
      for (const serverName of projectServers) {
        const runtimeServer = appState.servers[serverName];
        if (runtimeServer?.connectionStatus === "connected") {
          await handleDisconnect(serverName);
        }
      }

      if (isAuthenticated && !useLocalFallback) {
        setConvexActiveProjectId(targetProjectId);
      } else {
        dispatch({ type: "SWITCH_PROJECT", projectId: targetProjectId });
        dispatch({ type: "DELETE_PROJECT", projectId });
      }
    },
    [
      effectiveProjects,
      appState.servers,
      handleDisconnect,
      isAuthenticated,
      useLocalFallback,
      dispatch,
      setConvexActiveProjectId,
    ]
  );

  const clearLocalFallbackProjectSelection = useCallback(
    (deletedOrganizationId: string, fallbackOrganizationId?: string) => {
      const remainingEntries = Object.entries(appState.projects).filter(
        ([, project]) => project.organizationId !== deletedOrganizationId
      );
      const nextProjects =
        remainingEntries.length > 0
          ? Object.fromEntries(remainingEntries)
          : (() => {
              const project = createDefaultProject();
              return { [project.id]: project };
            })();
      const preferredProjectForFallbackOrg = fallbackOrganizationId
        ? Object.values(nextProjects).find(
            (project) => project.organizationId === fallbackOrganizationId
          )
        : undefined;
      const nextActiveProject =
        preferredProjectForFallbackOrg ??
        nextProjects[appState.activeProjectId] ??
        Object.values(nextProjects).find((project) => project.isDefault) ??
        Object.values(nextProjects)[0];
      const nextActiveProjectId =
        nextActiveProject?.id ?? Object.keys(nextProjects)[0];
      if (!nextActiveProjectId) {
        logger.warn(
          "clearLocalFallbackProjectSelection: no active project resolved",
          {
            deletedOrganizationId,
            fallbackOrganizationId,
            projectCount: Object.keys(nextProjects).length,
          }
        );
        return;
      }
      const nextServers = buildDisconnectedRuntimeServers(
        nextActiveProject?.servers
      );

      dispatch({
        type: "HYDRATE_STATE",
        payload: {
          ...appState,
          projects: nextProjects,
          activeProjectId: nextActiveProjectId,
          servers: nextServers,
          selectedServer: "none",
          selectedMultipleServers: [],
        },
      });
    },
    [appState, dispatch]
  );

  const isCloudSyncActive =
    isAuthenticated && !useLocalFallback && remoteProjects !== undefined;
  const selectedRuntimeServer =
    appState.selectedServer !== "none"
      ? appState.servers[appState.selectedServer]
      : undefined;
  const isSelectedServerSyncing =
    isCloudSyncActive &&
    !!selectedRuntimeServer &&
    !serverState.projectServers[appState.selectedServer] &&
    selectedRuntimeServer.connectionStatus !== "failed" &&
    selectedRuntimeServer.connectionStatus !== "disconnected";

  return {
    appState,
    isLoading,
    isLoadingRemoteProjects,
    // True once Convex has returned the flat-servers query for the active
    // project, OR when there's no queryable project id (sentinel like
    // "none"/"null" — query was skipped, so no data is ever coming).
    // Lets ServersTab distinguish "still loading" from "no real project".
    areServersHydrated:
      !isAuthenticated ||
      projectState.activeProjectServersFlat !== undefined ||
      !shouldQueryProjectId(projectState.activeProjectServersFlatProjectId),
    isCloudSyncActive,
    activeOrganizationId,
    setActiveOrganizationId,
    clearConvexActiveProjectSelection,
    clearLocalFallbackProjectSelection,
    pendingDashboardOAuth,

    projectServers: serverState.projectServers,
    displayServerConfigs: serverState.displayServerConfigs,
    connectedOrConnectingServerConfigs:
      serverState.connectedOrConnectingServerConfigs,
    selectedServerEntry: serverState.selectedServerEntry,
    selectedMCPConfig: serverState.selectedMCPConfig,
    // True when the currently selected server exists only in runtime state and
    // is still in a non-terminal state while cloud sync catches up. Once the
    // connection has failed or been disconnected, stop showing a loading UI
    // and let consumers fall back to the normal empty/error states.
    isSelectedServerSyncing,
    selectedMCPConfigs: serverState.selectedMCPConfigs,
    selectedMCPConfigsMap: serverState.selectedMCPConfigsMap,
    isMultiSelectMode: serverState.isMultiSelectMode,

    projects: effectiveProjects,
    activeProjectId: effectiveActiveProjectId,
    activeProject: serverState.activeProject,
    // The single active-host bundle every consumer should reach for: its
    // `mcpProfile` powers `ActiveMcpProfileProvider`, its `clientCapabilities`
    // and `connectionDefaults` flow through `withProjectConnectionDefaults`,
    // and `setActiveHostId` is the canonical writer for both the Chat tab's
    // ClientPicker and the global top-bar preview.
    activeHost,
    activeHostId,
    setActiveHostId,
    // Back-compat: `activeMcpProfile` was the per-call alias for
    // `activeHost?.mcpProfile`. Surfaces that still destructure it keep
    // working without churn.
    activeMcpProfile: activeHost?.mcpProfile,

    handleConnect: serverState.handleConnect,
    handleDisconnect: serverState.handleDisconnect,
    handleRuntimeDisconnect: serverState.handleRuntimeDisconnect,
    handleReconnect: serverState.handleReconnect,
    reconnectServerForClientSwitch: serverState.reconnectServerForClientSwitch,
    ensureServersReady: serverState.ensureServersReady,
    syncAgentStatus: serverState.syncAgentStatus,
    handleUpdate: serverState.handleUpdate,
    handleRemoveServer: serverState.handleRemoveServer,
    setSelectedServer: serverState.setSelectedServer,
    setSelectedMCPConfigs: serverState.setSelectedMCPConfigs,
    toggleMultiSelectMode: serverState.toggleMultiSelectMode,
    toggleServerSelection: serverState.toggleServerSelection,
    getValidAccessToken: serverState.getValidAccessToken,
    setSelectedMultipleServersToAllServers:
      serverState.setSelectedMultipleServersToAllServers,
    saveServerConfigWithoutConnecting:
      serverState.saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow:
      serverState.handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow:
      serverState.handleRefreshTokensFromOAuthFlow,
    persistRuntimeServerToProjectIfNeeded:
      serverState.persistRuntimeServerToProjectIfNeeded,

    handleSwitchProject,
    handleCreateProject: projectState.handleCreateProject,
    handleUpdateProject: projectState.handleUpdateProject,
    handleUpdateClientConfig: projectState.handleUpdateClientConfig,
    handleUpdateHostContext: projectState.handleUpdateHostContext,
    handleDeleteProject: projectState.handleDeleteProject,
    handleLeaveProject,
    handleDuplicateProject: projectState.handleDuplicateProject,
    handleSetDefaultProject: projectState.handleSetDefaultProject,
    handleProjectShared: projectState.handleProjectShared,
    handleExportProject: projectState.handleExportProject,
    handleImportProject: projectState.handleImportProject,
  };
}
