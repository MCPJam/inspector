import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
} from "react";
import { toast } from "sonner";
import {
  createLocalProjectId,
  type AppAction,
  type AppState,
  type Project,
} from "@/state/app-types";
import {
  useProjectMutations,
  useProjectQueries,
  useProjectServers,
  useProjectsBulkServers,
} from "./useProjects";
import { useEmbeddedBlobReadTelemetry } from "./useClientTelemetry";
import * as Sentry from "@sentry/react";

// Defensive invariant: the serialized servers payload sent to `createProject`
// must not be empty when the source project actually has servers. Emits a
// Sentry message rather than throwing so the user-facing "create" path still
// succeeds — we want to learn about the bug from the first occurrence, not
// from a confused user a week later.
//
// `bulkServerCount` and `embeddedServerCount` together pinpoint the cause:
// `bulkServerCount > 0` means the project had servers in the loaded list
// when the call was made (likely a serialization regression); a non-zero
// `embeddedServerCount` means the in-record copy still has servers.
function assertNotColdSharingEmptyServers(args: {
  callSite: "duplicate" | "migrate" | "import";
  sourceProjectId: string;
  serializedServerCount: number;
  bulkServerCount: number | null;
  embeddedServerCount: number;
}): void {
  if (args.serializedServerCount > 0) return;
  if ((args.bulkServerCount ?? 0) === 0 && args.embeddedServerCount === 0) {
    return;
  }
  Sentry.captureMessage(
    "Cold-share data-loss invariant tripped: createProject called with empty servers but source has servers",
    {
      level: "error",
      extra: {
        callSite: args.callSite,
        sourceProjectId: args.sourceProjectId,
        serializedServerCount: args.serializedServerCount,
        bulkServerCount: args.bulkServerCount,
        embeddedServerCount: args.embeddedServerCount,
      },
    },
  );
}
import {
  deserializeServersFromConvex,
  serializeServersForSharing,
} from "@/lib/project-serialization";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  pickProjectConnectionConfig,
  pickProjectHostContext,
  stableStringifyJson,
  type ProjectClientConfig,
  type ProjectConnectionConfigDraft,
  type ProjectConnectionDefaults,
  type ProjectHostContextDraft,
} from "@/lib/client-config";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/host-context-store";
import { useOrganizationBillingStatus } from "./useOrganizationBilling";
import {
  clearLegacyActiveProjectStorage,
  readStoredActiveProjectId,
  writeStoredActiveProjectId,
} from "@/lib/active-project-storage";

function stringifyProjectClientConfig(
  clientConfig: ProjectClientConfig | undefined,
) {
  return stableStringifyJson(clientConfig ?? null);
}

interface PendingClientConfigSync {
  id: string;
  projectId: string;
  expectedSerializedConfig: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const PROJECT_CLIENT_CONFIG_SYNC_INTERRUPTED_ERROR_MESSAGE =
  "Project client config sync was interrupted.";

interface ClientConfigSaveController<T> {
  beginSave: (input: {
    projectId: string;
    savedConfig: T | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
  markSaved: (input: {
    projectId: string;
    savedConfig: T | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
  failSave: (input: {
    projectId: string;
    savedConfig: T | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
}

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

function isSyntheticDefaultProject(project: Project) {
  return (
    project.isDefault === true &&
    project.sharedProjectId === undefined &&
    project.organizationId === undefined &&
    project.name === "Default" &&
    project.description === "Default project" &&
    Object.keys(project.servers).length === 0
  );
}

function doesStoreSliceBelongToProject(
  activeProjectId: string | null,
  projectId: string,
) {
  return activeProjectId === projectId;
}

function canApplyStoreSaveState(
  activeProjectId: string | null,
  projectId: string,
) {
  return activeProjectId === null || activeProjectId === projectId;
}

export interface UseProjectStateParams {
  appState: AppState;
  dispatch: Dispatch<AppAction>;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  hasOrganizations: boolean;
  isLoadingOrganizations: boolean;
  validOrganizationIds: string[];
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  /**
   * Stable identifier for the active actor (user id or guest id). Scopes the
   * persisted active-project selection so a previous actor's choice doesn't
   * drive Convex queries against a project the current actor doesn't own. May
   * be null while the actor is still resolving.
   */
  currentActorKey: string | null;
  /**
   * True when a WorkOS user is signed in. Guests are Convex-authenticated
   * (`isAuthenticated`) but have no WorkOS session — this flag distinguishes
   * the two so the project provisioning path can take the guest branch.
   */
  hasSignedInUser: boolean;
  logger: LoggerLike;
}

export function useProjectState({
  appState,
  dispatch,
  isAuthenticated,
  isAuthLoading,
  hasOrganizations,
  isLoadingOrganizations,
  validOrganizationIds,
  activeOrganizationId,
  routeOrganizationId,
  currentActorKey,
  hasSignedInUser,
  logger,
}: UseProjectStateParams) {
  const projectOrganizationId = routeOrganizationId ?? activeOrganizationId;
  const hasResolvedProjectOrganizationSelection =
    !isLoadingOrganizations && projectOrganizationId !== undefined;
  const shouldScopeLocalFallbackByOrganization =
    isAuthenticated &&
    hasResolvedProjectOrganizationSelection &&
    projectOrganizationId !== undefined;
  const billingOrganizationId = routeOrganizationId
    ? routeOrganizationId
    : !isLoadingOrganizations &&
        activeOrganizationId &&
        validOrganizationIds.includes(activeOrganizationId)
      ? activeOrganizationId
      : undefined;
  const {
    allProjects: allRemoteProjects,
    projects: remoteProjects,
    isLoading: isLoadingProjects,
  } = useProjectQueries({
    isAuthenticated,
    organizationId: projectOrganizationId,
  });
  // Bulk-fetch servers for every visible project in one query so the picker
  // can render server counts without N round trips. The active project still
  // reads via the flat single-project query (see `useProjectServers` below);
  // the bulk query covers every other project the picker renders.
  const bulkServerProjectIds = useMemo(
    () => (remoteProjects ?? []).map((p) => p._id),
    [remoteProjects],
  );
  const {
    serversByProject: bulkServersByProject,
    isLoading: isLoadingBulkServers,
  } = useProjectsBulkServers({
    projectIds: bulkServerProjectIds,
    isAuthenticated,
  });
  const emitEmbeddedBlobRead = useEmbeddedBlobReadTelemetry();
  const {
    createProject: convexCreateProject,
    ensureDefaultProject: convexEnsureDefaultProject,
    updateProject: convexUpdateProject,
    patchProjectDefaultConnection: convexPatchProjectDefaultConnection,
    deleteProject: convexDeleteProject,
  } = useProjectMutations();
  const billingStatus = useOrganizationBillingStatus(
    billingOrganizationId ?? null,
    { enabled: isAuthenticated },
  );

  // "Authed but with no organization" is the empty-org-state for signed-in
  // users. Guests are Convex-authenticated without a WorkOS user *and* have
  // no orgs by design — they should not be coerced into the empty-state path
  // because their projects live under `guestExternalId`, not an organization.
  const shouldTreatRemoteProjectsAsEmpty =
    isAuthenticated &&
    hasSignedInUser &&
    !isLoadingOrganizations &&
    !hasOrganizations &&
    !routeOrganizationId &&
    !activeOrganizationId;
  const isGuestActor = isAuthenticated && !hasSignedInUser;

  // Guests own exactly one project (provisioned by ensureDefaultGuestProject),
  // so persisting an "active project" selection for them is dead weight that
  // can only diverge from truth. Authed users keep the per-actor key as a
  // first-paint hint; the server's project list is still the source of truth.
  const [convexActiveProjectId, setConvexActiveProjectId] = useState<
    string | null
  >(() => (isGuestActor ? null : readStoredActiveProjectId(currentActorKey)));
  const [hasHydratedActiveProject, setHasHydratedActiveProject] = useState(
    () => currentActorKey != null,
  );
  const activeProjectActorKeyRef = useRef<string | null>(currentActorKey);
  const activeProjectActorIsGuestRef = useRef(isGuestActor);

  const migrationInFlightRef = useRef(new Set<string>());
  const ensureDefaultInFlightRef = useRef(new Set<string>());
  const ensureDefaultCompletedRef = useRef(new Set<string>());
  const migrationErrorNotifiedRef = useRef(new Set<string>());
  const pendingClientConfigSyncRef = useRef<
    Map<string, PendingClientConfigSync>
  >(new Map());
  const pendingClientConfigSyncByProjectRef = useRef<Map<string, string>>(
    new Map(),
  );
  // Convex is the single source of truth for projects post-unification. The
  // legacy `useLocalFallback` flow that hydrated from localStorage when
  // Convex was slow has been removed (tradeoff: local CLI now requires
  // Convex connectivity). When Convex hasn't resolved, the existing
  // loading-skeleton path (`isLoadingProjects`/`isLoadingRemoteProjects`)
  // already renders — no separate "unreachable" banner is added; the user
  // sees the same skeleton they'd see during a normal cold start. The
  // constant below is kept inline so the dead-code branches that still
  // reference `shouldUseLocalFallback` collapse cleanly without renames.
  const shouldUseLocalFallback = false as const;

  const clearConvexActiveProjectSelection = useCallback(() => {
    setConvexActiveProjectId(null);
    writeStoredActiveProjectId(activeProjectActorKeyRef.current, null);
  }, []);

  // Project id that the flat-server query should target. We can't wait for
  // the auto-set effect to copy convexActiveProjectId from remoteProjects[0]
  // — the consumer renders one frame earlier with effectiveActiveProjectId
  // resolving to the same fallback, so the flat query has to fire on that
  // same frame or the project briefly renders as "no servers". Falling back
  // to remoteProjects[0] mirrors what the auto-set effect would land on.
  const resolvedActiveProjectIdForServers = shouldTreatRemoteProjectsAsEmpty
    ? null
    : (convexActiveProjectId ?? remoteProjects?.[0]?._id ?? null);

  const { servers: activeProjectServersFlat, isLoading: isLoadingServers } =
    useProjectServers({
      projectId: resolvedActiveProjectIdForServers,
      isAuthenticated,
    });

  const clearPendingClientConfigSync = useCallback(
    (pendingId: string, error?: Error) => {
      const pending = pendingClientConfigSyncRef.current.get(pendingId);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeoutId);
      pendingClientConfigSyncRef.current.delete(pendingId);
      if (
        pendingClientConfigSyncByProjectRef.current.get(pending.projectId) ===
        pendingId
      ) {
        pendingClientConfigSyncByProjectRef.current.delete(
          pending.projectId,
        );
      }

      if (error) {
        pending.reject(error);
      }
    },
    [],
  );

  const clearAllPendingClientConfigSyncs = useCallback((error?: Error) => {
    const pendingIds = Array.from(
      pendingClientConfigSyncRef.current.keys(),
    );
    if (pendingIds.length === 0) {
      return;
    }

    for (const pendingId of pendingIds) {
      clearPendingClientConfigSync(pendingId, error);
    }
  }, [clearPendingClientConfigSync]);

  // No fallback timer: when Convex hasn't resolved, `isLoadingProjects`/
  // `isLoadingRemoteProjects` are already true and the existing loading
  // skeleton on the servers page renders. We don't surface a separate
  // "unreachable" banner — the loading skeleton is the failure mode.

  useEffect(() => {
    if (
      isAuthenticated &&
      !shouldUseLocalFallback &&
      !shouldTreatRemoteProjectsAsEmpty
    ) {
      return;
    }

    clearAllPendingClientConfigSyncs(
      new Error(PROJECT_CLIENT_CONFIG_SYNC_INTERRUPTED_ERROR_MESSAGE),
    );
  }, [
    clearAllPendingClientConfigSyncs,
    isAuthenticated,
    shouldTreatRemoteProjectsAsEmpty,
    shouldUseLocalFallback,
  ]);

  useEffect(() => {
    return () => {
      clearAllPendingClientConfigSyncs(
        new Error(PROJECT_CLIENT_CONFIG_SYNC_INTERRUPTED_ERROR_MESSAGE),
      );
    };
  }, [clearAllPendingClientConfigSyncs]);

  useEffect(() => {
    if (!shouldTreatRemoteProjectsAsEmpty || !convexActiveProjectId) {
      return;
    }

    clearConvexActiveProjectSelection();
  }, [
    shouldTreatRemoteProjectsAsEmpty,
    convexActiveProjectId,
    clearConvexActiveProjectSelection,
  ]);

  const isLoadingRemoteProjects =
    (!shouldTreatRemoteProjectsAsEmpty &&
      isAuthenticated &&
      !shouldUseLocalFallback &&
      (remoteProjects === undefined || isLoadingServers)) ||
    (isAuthLoading && !!convexActiveProjectId);

  // Project ids whose server count was sourced from the in-record copy on
  // this render. Telemetry is emitted in a separate effect (below) so we
  // don't perform side effects during the render path. The resulting counter
  // is what we watch to verify that no consumer still depends on the
  // in-record copy before retiring it.
  const embeddedBlobReadEventsThisRender = useMemo<
    Array<{ projectId: string; serverCount: number }>
  >(() => {
    if (!remoteProjects) return [];
    const events: Array<{ projectId: string; serverCount: number }> = [];
    for (const rw of remoteProjects) {
      if (rw._id === resolvedActiveProjectIdForServers) continue;
      if (bulkServersByProject[rw._id] !== undefined) continue;
      if (rw.servers && Object.keys(rw.servers).length > 0) {
        events.push({
          projectId: rw._id,
          serverCount: Object.keys(rw.servers).length,
        });
      }
    }
    return events;
  }, [remoteProjects, resolvedActiveProjectIdForServers, bulkServersByProject]);

  useEffect(() => {
    for (const event of embeddedBlobReadEventsThisRender) {
      emitEmbeddedBlobRead(event);
    }
  }, [embeddedBlobReadEventsThisRender, emitEmbeddedBlobRead]);

  const convexProjects = useMemo((): Record<string, Project> => {
    if (!remoteProjects) return {};
    return Object.fromEntries(
      remoteProjects.map((rw) => {
        let deserializedServers: Project["servers"] = {};

        if (rw._id === resolvedActiveProjectIdForServers) {
          // Active project: flat servers table is authoritative. While the
          // flat query is in flight, leave servers empty rather than falling
          // through to rw.servers — the embedded map is vestigial and is
          // {} for guest projects, which would render as "no servers" until
          // the flat list arrives. Consumers gate on isLoadingRemoteProjects.
          if (activeProjectServersFlat !== undefined) {
            deserializedServers = deserializeServersFromConvex(
              activeProjectServersFlat,
            );
          }
        } else {
          // Bulk query is the primary source. Stale-while-revalidate:
          // render `rw.servers` (the in-record copy) until the bulk query
          // resolves, then swap to the fresh result. Without the fallback
          // the picker would briefly flash "0 server(s)" on every fresh load.
          const bulk = bulkServersByProject[rw._id];
          if (bulk !== undefined) {
            deserializedServers = deserializeServersFromConvex(bulk);
          } else if (rw.servers) {
            deserializedServers = deserializeServersFromConvex(rw.servers);
          }
        }

        return [
          rw._id,
          {
            id: rw._id,
            name: rw.name,
            description: rw.description,
            icon: rw.icon,
            clientConfig: rw.clientConfig,
            servers: deserializedServers,
            createdAt: new Date(rw.createdAt),
            updatedAt: new Date(rw.updatedAt),
            canDeleteProject: rw.canDeleteProject,
            sharedProjectId: rw._id,
            organizationId: rw.organizationId,
            visibility: rw.visibility,
          } as Project,
        ];
      }),
    );
  }, [
    remoteProjects,
    resolvedActiveProjectIdForServers,
    activeProjectServersFlat,
    bulkServersByProject,
  ]);

  useEffect(() => {
    if (pendingClientConfigSyncRef.current.size === 0) {
      return;
    }

    for (const [pendingId, pending] of pendingClientConfigSyncRef.current) {
      const syncedClientConfig =
        convexProjects[pending.projectId]?.clientConfig;
      if (
        stringifyProjectClientConfig(syncedClientConfig) !==
        pending.expectedSerializedConfig
      ) {
        continue;
      }

      clearPendingClientConfigSync(pendingId);
      pending.resolve();
    }
  }, [clearPendingClientConfigSync, convexProjects]);

  const scopedLocalProjects = useMemo((): Record<string, Project> => {
    if (!shouldScopeLocalFallbackByOrganization) {
      return appState.projects;
    }

    return Object.fromEntries(
      Object.entries(appState.projects).filter(
        ([, project]) => project.organizationId === projectOrganizationId,
      ),
    );
  }, [appState.projects, shouldScopeLocalFallbackByOrganization, projectOrganizationId]);

  // Legacy fallback memo. Convex is the only source of truth post-unification;
  // `useLocalFallback` is permanently false. Kept as a stable empty/identity
  // reference so the dead-code branches below collapse without renames.
  const localFallbackProjects: Record<string, Project> = appState.projects;

  const authenticatedMergedProjects = useMemo((): Record<string, Project> => {
    // Convex is the only source of truth for authenticated project lists.
    // Local app-state projects may still be inspected by the migration path
    // below, but they must not render after actor or organization changes.
    return convexProjects;
  }, [convexProjects]);

  const activeScopedLocalProject = useMemo(
    () => scopedLocalProjects[appState.activeProjectId],
    [scopedLocalProjects, appState.activeProjectId],
  );

  const activeScopedRemoteProjectId =
    activeScopedLocalProject?.sharedProjectId ?? null;

  // Authenticated users never keep local-fallback projects in the rendered
  // project list. Their canonical project set lives in Convex; local rows are
  // only inputs to migration/import paths.
  const shouldKeepLocalActiveProject = false;

  const effectiveProjects = useMemo((): Record<string, Project> => {
    if (shouldTreatRemoteProjectsAsEmpty) {
      return {};
    }
    if (shouldUseLocalFallback) {
      return localFallbackProjects;
    }
    if (isAuthenticated && remoteProjects !== undefined) {
      return authenticatedMergedProjects;
    }
    if (isAuthenticated) {
      return {};
    }
    if (isAuthLoading && convexActiveProjectId) {
      return {};
    }
    return appState.projects;
  }, [
    shouldUseLocalFallback,
    localFallbackProjects,
    isAuthenticated,
    remoteProjects,
    authenticatedMergedProjects,
    isAuthLoading,
    convexActiveProjectId,
    shouldTreatRemoteProjectsAsEmpty,
  ]);

  const effectiveActiveProjectId = useMemo(() => {
    if (shouldTreatRemoteProjectsAsEmpty) {
      return "none";
    }
    if (shouldUseLocalFallback) {
      if (localFallbackProjects[appState.activeProjectId]) {
        return appState.activeProjectId;
      }
      const defaultProjectId = Object.entries(localFallbackProjects).find(
        ([, project]) => project.isDefault,
      )?.[0];
      return (
        defaultProjectId ?? Object.keys(localFallbackProjects)[0] ?? "none"
      );
    }
    if (isAuthenticated && remoteProjects !== undefined) {
      if (
        shouldKeepLocalActiveProject &&
        effectiveProjects[appState.activeProjectId]
      ) {
        return appState.activeProjectId;
      }

      if (
        activeScopedRemoteProjectId &&
        effectiveProjects[activeScopedRemoteProjectId]
      ) {
        return activeScopedRemoteProjectId;
      }

      if (
        convexActiveProjectId &&
        effectiveProjects[convexActiveProjectId]
      ) {
        return convexActiveProjectId;
      }
      const firstId = Object.keys(effectiveProjects)[0];
      return firstId || "none";
    }
    return appState.activeProjectId;
  }, [
    shouldUseLocalFallback,
    appState.activeProjectId,
    localFallbackProjects,
    scopedLocalProjects,
    isAuthenticated,
    remoteProjects,
    convexActiveProjectId,
    effectiveProjects,
    activeScopedRemoteProjectId,
    shouldKeepLocalActiveProject,
    shouldTreatRemoteProjectsAsEmpty,
  ]);

  const migratableLocalProjects = useMemo(
    () =>
      Object.values(appState.projects).filter(
        (project) =>
          !project.sharedProjectId &&
          (!shouldScopeLocalFallbackByOrganization ||
            project.organizationId === projectOrganizationId) &&
          !isSyntheticDefaultProject(project),
      ),
    [
      appState.projects,
      shouldScopeLocalFallbackByOrganization,
      projectOrganizationId,
    ],
  );
  const migratableLocalProjectCount = migratableLocalProjects.length;
  const hasAnyRemoteProjects = (allRemoteProjects?.length ?? 0) > 0;
  const hasCurrentOrganizationProjects = (remoteProjects?.length ?? 0) > 0;
  const canManageBillingForProjectActions = projectOrganizationId
    ? (billingStatus?.canManageBilling ?? false)
    : true;

  useEffect(() => {
    if (shouldTreatRemoteProjectsAsEmpty) {
      return;
    }

    if (isAuthenticated && remoteProjects && remoteProjects.length > 0) {
      if (shouldKeepLocalActiveProject) {
        if (convexActiveProjectId) {
          clearConvexActiveProjectSelection();
        }
        return;
      }

      if (
        !convexActiveProjectId ||
        !convexProjects[convexActiveProjectId]
      ) {
        if (
          activeScopedRemoteProjectId &&
          convexProjects[activeScopedRemoteProjectId]
        ) {
          setConvexActiveProjectId(activeScopedRemoteProjectId);
          return;
        }

        setConvexActiveProjectId(remoteProjects[0]._id);
      }
    }
  }, [
    isAuthenticated,
    remoteProjects,
    convexActiveProjectId,
    convexProjects,
    activeScopedRemoteProjectId,
    shouldKeepLocalActiveProject,
    clearConvexActiveProjectSelection,
    shouldTreatRemoteProjectsAsEmpty,
  ]);

  // Re-hydrate the persisted active project id whenever the actor changes
  // (sign-in/sign-out, guest cookie resolves). Without this, a sign-in would
  // keep a stale guest's project id in memory and drive useProjectServers to
  // query a project the new actor doesn't own.
  useEffect(() => {
    clearLegacyActiveProjectStorage();
    if (
      currentActorKey === activeProjectActorKeyRef.current &&
      isGuestActor === activeProjectActorIsGuestRef.current
    ) {
      return;
    }
    activeProjectActorKeyRef.current = currentActorKey;
    activeProjectActorIsGuestRef.current = isGuestActor;
    // Clear provisioning guards so the new actor's default-project path runs clean.
    ensureDefaultInFlightRef.current.clear();
    ensureDefaultCompletedRef.current.clear();
    migrationInFlightRef.current.clear();
    migrationErrorNotifiedRef.current.clear();
    if (isGuestActor) {
      setConvexActiveProjectId(null);
    } else {
      setConvexActiveProjectId(readStoredActiveProjectId(currentActorKey));
    }
    setHasHydratedActiveProject(currentActorKey != null);
  }, [currentActorKey, isGuestActor]);

  // Guests never persist an active-project selection. Any per-actor entry
  // sitting in localStorage (from older code paths) is dead weight that can
  // only drive useProjectServers to query a project this actor doesn't own.
  useEffect(() => {
    if (!isGuestActor) return;
    if (!currentActorKey) return;
    writeStoredActiveProjectId(currentActorKey, null);
  }, [isGuestActor, currentActorKey]);

  useEffect(() => {
    if (!hasHydratedActiveProject) {
      return;
    }
    if (
      activeProjectActorKeyRef.current !== currentActorKey ||
      activeProjectActorIsGuestRef.current !== isGuestActor
    ) {
      return;
    }
    if (isGuestActor) return;
    writeStoredActiveProjectId(currentActorKey, convexActiveProjectId);
  }, [
    convexActiveProjectId,
    currentActorKey,
    hasHydratedActiveProject,
    isGuestActor,
  ]);

  useEffect(() => {
    if (!isAuthenticated || shouldUseLocalFallback) {
      migrationInFlightRef.current.clear();
      ensureDefaultInFlightRef.current.clear();
      // Intentionally NOT clearing ensureDefaultCompletedRef here — it must
      // survive transient auth-state flickers so that a project that was
      // already successfully created isn't re-created when the Convex
      // subscription briefly returns an empty result during reconnection.
      migrationErrorNotifiedRef.current.clear();
    }
  }, [isAuthenticated, shouldUseLocalFallback]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      shouldUseLocalFallback ||
      allRemoteProjects === undefined ||
      allRemoteProjects.length > 0 ||
      migratableLocalProjectCount === 0
    ) {
      migrationErrorNotifiedRef.current.clear();
    }
  }, [
    isAuthenticated,
    shouldUseLocalFallback,
    allRemoteProjects,
    migratableLocalProjectCount,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (isGuestActor) return;
    if (shouldTreatRemoteProjectsAsEmpty) return;
    if (shouldUseLocalFallback) return;
    if (!hasResolvedProjectOrganizationSelection) return;
    if (allRemoteProjects === undefined) return;
    if (allRemoteProjects.length > 0) return;
    if (migratableLocalProjectCount === 0) return;

    const organizationId = projectOrganizationId;
    if (organizationId === undefined) return;

    logger.info("Migrating local projects to Convex", {
      count: migratableLocalProjectCount,
    });

    const migrateProject = async (project: Project) => {
      if (migrationInFlightRef.current.has(project.id)) {
        return;
      }

      migrationInFlightRef.current.add(project.id);

      try {
        const serializedServers = serializeServersForSharing(project.servers);
        const bulkForSource = bulkServersByProject[project.id];
        assertNotColdSharingEmptyServers({
          callSite: "migrate",
          sourceProjectId: project.id,
          serializedServerCount: Object.keys(serializedServers).length,
          bulkServerCount: bulkForSource ? bulkForSource.length : null,
          embeddedServerCount: Object.keys(project.servers ?? {}).length,
        });
        const projectId = await convexCreateProject({
          name: project.name,
          description: project.description,
          clientConfig: project.clientConfig,
          servers: serializedServers,
          organizationId,
        });
        dispatch({
          type: "UPDATE_PROJECT",
          projectId: project.id,
          updates: {
            sharedProjectId: projectId as string,
            organizationId,
          },
        });
        logger.info("Migrated project to Convex", { name: project.name });
      } catch (error) {
        migrationInFlightRef.current.delete(project.id);
        const requestKey = organizationId;
        if (!migrationErrorNotifiedRef.current.has(requestKey)) {
          migrationErrorNotifiedRef.current.add(requestKey);
          toast.error(
            getBillingErrorMessage(
              error,
              "Some local projects could not be migrated",
              canManageBillingForProjectActions,
            ),
          );
        }
        logger.error("Failed to migrate project", {
          name: project.name,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };

    Promise.all(migratableLocalProjects.map(migrateProject));
  }, [
    isAuthenticated,
    isGuestActor,
    shouldUseLocalFallback,
    allRemoteProjects,
    migratableLocalProjects,
    migratableLocalProjectCount,
    convexCreateProject,
    dispatch,
    logger,
    projectOrganizationId,
    hasResolvedProjectOrganizationSelection,
    canManageBillingForProjectActions,
    shouldTreatRemoteProjectsAsEmpty,
    bulkServersByProject,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (isGuestActor) return;
    if (shouldTreatRemoteProjectsAsEmpty) return;
    if (shouldUseLocalFallback) return;
    if (!hasResolvedProjectOrganizationSelection) return;
    if (remoteProjects === undefined) return;
    if (hasCurrentOrganizationProjects) return;
    if (!hasAnyRemoteProjects && migratableLocalProjectCount > 0) return;

    const organizationId = projectOrganizationId;
    if (organizationId === undefined) return;

    const requestKey = organizationId;
    if (ensureDefaultInFlightRef.current.has(requestKey)) {
      return;
    }
    if (ensureDefaultCompletedRef.current.has(requestKey)) {
      return;
    }

    ensureDefaultInFlightRef.current.add(requestKey);

    convexEnsureDefaultProject({ organizationId })
      .then(() => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        ensureDefaultCompletedRef.current.add(requestKey);
      })
      .catch((error) => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        logger.error("Failed to ensure default project", {
          organizationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
  }, [
    isAuthenticated,
    isGuestActor,
    shouldUseLocalFallback,
    remoteProjects,
    hasCurrentOrganizationProjects,
    hasAnyRemoteProjects,
    migratableLocalProjectCount,
    convexEnsureDefaultProject,
    projectOrganizationId,
    hasResolvedProjectOrganizationSelection,
    logger,
    shouldTreatRemoteProjectsAsEmpty,
  ]);

  // Guest project provisioning. Guests can have a personal organization row,
  // but they must not call the org-scoped ensureDefaultProject path with an
  // explicit organizationId. When remoteProjects resolves to an empty list for
  // a guest actor, lazily create the guest default with no org argument so the
  // rest of the app sees a normal projectId.
  useEffect(() => {
    if (!isGuestActor) return;
    if (shouldUseLocalFallback) return;
    if (remoteProjects === undefined) return;
    if (remoteProjects.length > 0) return;
    if (!currentActorKey) return;

    const requestKey = `guest:${currentActorKey}`;
    if (ensureDefaultInFlightRef.current.has(requestKey)) return;
    if (ensureDefaultCompletedRef.current.has(requestKey)) return;

    ensureDefaultInFlightRef.current.add(requestKey);
    convexEnsureDefaultProject({})
      .then((projectId) => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        ensureDefaultCompletedRef.current.add(requestKey);
        // Stick the new project id as the active selection so the rest of
        // the app picks it up over any synthetic local-fallback project that
        // appState may have hydrated from storage. UI surfaces gate on
        // useAppReady() — which goes ready once this projectId reaches
        // useApiContext via the normal React render — so no eager
        // apiContext inject is needed here.
        if (typeof projectId === "string") {
          setConvexActiveProjectId(projectId);
        }
      })
      .catch((error) => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        logger.error("Failed to ensure default guest project", {
          actorKey: currentActorKey,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
  }, [
    isGuestActor,
    shouldUseLocalFallback,
    remoteProjects,
    currentActorKey,
    convexEnsureDefaultProject,
    logger,
  ]);

  const handleCreateProject = useCallback(
    async (name: string, switchTo: boolean = false) => {
      if (isAuthenticated && !shouldUseLocalFallback) {
        const organizationId = projectOrganizationId;
        if (
          shouldTreatRemoteProjectsAsEmpty ||
          !hasResolvedProjectOrganizationSelection ||
          organizationId === undefined
        ) {
          toast.error("Create or join an organization to create projects.");
          return "";
        }
        try {
          const projectId = await convexCreateProject({
            name,
            clientConfig: undefined,
            servers: {},
            organizationId,
          });
          if (switchTo && projectId) {
            setConvexActiveProjectId(projectId as string);
          }
          toast.success(`Project "${name}" created`);
          return projectId as string;
        } catch (error) {
          toast.error(
            getBillingErrorMessage(
              error,
              "Failed to create project",
              canManageBillingForProjectActions,
            ),
          );
          return "";
        }
      }

      if (
        isAuthenticated &&
        (!hasResolvedProjectOrganizationSelection ||
          projectOrganizationId === undefined)
      ) {
        toast.error("Create or join an organization to create projects.");
        return "";
      }

      const newProject: Project = {
        id: createLocalProjectId(),
        name,
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        organizationId: isAuthenticated ? projectOrganizationId : undefined,
      };
      dispatch({ type: "CREATE_PROJECT", project: newProject });

      if (switchTo) {
        dispatch({ type: "SWITCH_PROJECT", projectId: newProject.id });
      }

      toast.success(`Project "${name}" created`);
      return newProject.id;
    },
    [
      isAuthenticated,
      shouldUseLocalFallback,
      shouldTreatRemoteProjectsAsEmpty,
      convexCreateProject,
      dispatch,
      projectOrganizationId,
      hasResolvedProjectOrganizationSelection,
      canManageBillingForProjectActions,
    ],
  );

  const handleUpdateProject = useCallback(
    async (projectId: string, updates: Partial<Project>): Promise<void> => {
      if (isAuthenticated && !shouldUseLocalFallback) {
        try {
          const updateData: any = { projectId };
          if (updates.name !== undefined) updateData.name = updates.name;
          if (updates.description !== undefined) {
            updateData.description = updates.description;
          }
          if (updates.icon !== undefined) updateData.icon = updates.icon;
          if (updates.visibility !== undefined) {
            updateData.visibility = updates.visibility;
          }
          if (updates.servers !== undefined) {
            logger.warn(
              "Ignoring servers in handleUpdateProject for authenticated user - use individual server operations",
            );
          }
          await convexUpdateProject(updateData);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("Failed to update project", {
            error: errorMessage,
          });
          toast.error(errorMessage);
          throw error instanceof Error ? error : new Error(errorMessage);
        }
      } else {
        dispatch({ type: "UPDATE_PROJECT", projectId, updates });
      }
    },
    [
      isAuthenticated,
      shouldUseLocalFallback,
      convexUpdateProject,
      logger,
      dispatch,
    ],
  );

  const persistProjectClientConfig = useCallback(
    async <T,>({
      projectId,
      slice,
      savedSlice,
      controller,
    }: {
      projectId: string;
      // The slice the user actually edited. Only this section is sent
      // to the backend (the helper preserves the others) and only this
      // section is updated optimistically — passing the full clientConfig
      // would let a slow connection save clobber a newer host-context
      // save and vice versa (P2). `connectionConfig: undefined` means
      // "reset to default" for the connection slice.
      slice:
        | {
            kind: "connection";
            connectionConfig: ProjectConnectionConfigDraft | undefined;
          }
        | {
            kind: "hostContext";
            hostContext: ProjectHostContextDraft;
          };
      savedSlice: T | undefined;
      controller: ClientConfigSaveController<T>;
    }): Promise<void> => {
      // Phase 4: writes go through `hostConfigsV2.patchProjectDefaultConnection`.
      // The legacy project-doc echo wait is gone (v2 is the canonical
      // target), but we still need a sync-pending window during the
      // mutation in-flight period. `useProjectClientConfigSyncPending`
      // (and the `assertClientConfigSynced` /
      // `notifyIfClientConfigSyncPending` guards in use-server-state)
      // gate connect / reconnect / test / resolver paths so a user who
      // saves and immediately reconnects can't be served the still-stale
      // `activeProject.clientConfig` (the optimistic slice-merge dispatch
      // only runs after the await resolves). beginSave with
      // awaitRemoteEcho:true sets that pending state; markSaved /
      // failSave with awaitRemoteEcho:false skip the controller's
      // pending-data gate so we clear immediately on mutation completion.
      const useV2Write = isAuthenticated && !shouldUseLocalFallback;

      controller.beginSave({
        projectId,
        savedConfig: savedSlice,
        awaitRemoteEcho: useV2Write,
      });

      // Resolve the connection slice into both the v2 wire payload and
      // the local optimistic state. Reset (`connectionConfig ===
      // undefined`) explicitly sends `{ headers: {}, requestTimeout:
      // DEFAULT_REQUEST_TIMEOUT_MS }` — sending headers-only would let
      // the backend's helper preserve the user's previous timeout while
      // the optimistic local state shows defaults, drifting back to the
      // old timeout on the next refetch.
      let resolvedConnectionDefaults:
        | ProjectConnectionDefaults
        | undefined;
      if (slice.kind === "connection") {
        const { connectionConfig } = slice;
        if (connectionConfig === undefined) {
          resolvedConnectionDefaults = {
            headers: {},
            requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
          };
        } else {
          const cd = connectionConfig.connectionDefaults;
          if (cd === undefined) {
            resolvedConnectionDefaults = {
              headers: {},
              requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
            };
          } else {
            const requestTimeout =
              cd.requestTimeout !== undefined &&
              Number.isFinite(cd.requestTimeout)
                ? cd.requestTimeout
                : DEFAULT_REQUEST_TIMEOUT_MS;
            resolvedConnectionDefaults = {
              headers: cd.headers ?? {},
              requestTimeout,
            };
          }
        }
      }
      const resolvedClientCapabilities =
        slice.kind === "connection"
          ? slice.connectionConfig === undefined
            ? {}
            : slice.connectionConfig.clientCapabilities
          : undefined;

      if (useV2Write) {
        try {
          if (slice.kind === "connection") {
            await convexPatchProjectDefaultConnection({
              projectId,
              connectionDefaults: resolvedConnectionDefaults,
              clientCapabilities: resolvedClientCapabilities,
              // Leave hostContext untouched on the backend — passing
              // undefined preserves the existing value (P2).
              hostContext: undefined,
            });
          } else {
            await convexPatchProjectDefaultConnection({
              projectId,
              // Leave connection portions untouched on the backend.
              connectionDefaults: undefined,
              clientCapabilities: undefined,
              hostContext: slice.hostContext,
            });
          }
        } catch (error) {
          controller.failSave({
            projectId,
            savedConfig: savedSlice,
            awaitRemoteEcho: false,
          });
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("Failed to update project client config", {
            error: errorMessage,
            projectId,
          });
          toast.error(errorMessage);
          throw error instanceof Error ? error : new Error(errorMessage);
        }
        // Optimistically update only the slice the user edited. Using
        // the slice-merge action (rather than dispatching a recomposed
        // full clientConfig) keeps the sibling slice authoritative
        // even when two saves race. The reactive project query will
        // catch up on its next refetch.
        if (slice.kind === "connection") {
          dispatch({
            type: "UPDATE_PROJECT_CLIENT_CONFIG_SLICE",
            projectId,
            slice: {
              kind: "connection",
              connectionDefaults: resolvedConnectionDefaults,
              clientCapabilities: resolvedClientCapabilities ?? {},
            },
          });
        } else {
          dispatch({
            type: "UPDATE_PROJECT_CLIENT_CONFIG_SLICE",
            projectId,
            slice: { kind: "hostContext", hostContext: slice.hostContext },
          });
        }
        controller.markSaved({
          projectId,
          savedConfig: savedSlice,
          awaitRemoteEcho: false,
        });
        return;
      }

      if (slice.kind === "connection") {
        dispatch({
          type: "UPDATE_PROJECT_CLIENT_CONFIG_SLICE",
          projectId,
          slice: {
            kind: "connection",
            connectionDefaults: resolvedConnectionDefaults,
            clientCapabilities: resolvedClientCapabilities ?? {},
          },
        });
      } else {
        dispatch({
          type: "UPDATE_PROJECT_CLIENT_CONFIG_SLICE",
          projectId,
          slice: { kind: "hostContext", hostContext: slice.hostContext },
        });
      }
      controller.markSaved({
        projectId,
        savedConfig: savedSlice,
        awaitRemoteEcho: false,
      });
    },
    [
      isAuthenticated,
      shouldUseLocalFallback,
      convexPatchProjectDefaultConnection,
      logger,
      dispatch,
    ],
  );

  const resolvePersistedConnectionConfig = useCallback(
    (projectId: string): ProjectConnectionConfigDraft => {
      const clientConfigStore = useClientConfigStore.getState();
      const projectClientConfig = effectiveProjects[projectId]?.clientConfig;
      const scopedStoreConfig = doesStoreSliceBelongToProject(
        clientConfigStore.activeProjectId,
        projectId,
      )
        ? clientConfigStore.savedConfig ?? clientConfigStore.defaultConfig
        : undefined;

      return scopedStoreConfig ?? pickProjectConnectionConfig(projectClientConfig);
    },
    [effectiveProjects],
  );

  const resolvePersistedHostContext = useCallback(
    (projectId: string): ProjectHostContextDraft => {
      const hostContextStore = useHostContextStore.getState();
      const projectClientConfig = effectiveProjects[projectId]?.clientConfig;
      const scopedStoreHostContext = doesStoreSliceBelongToProject(
        hostContextStore.activeProjectId,
        projectId,
      )
        ? hostContextStore.savedHostContext ?? hostContextStore.defaultHostContext
        : undefined;

      return scopedStoreHostContext ?? pickProjectHostContext(projectClientConfig);
    },
    [effectiveProjects],
  );

  const connectionConfigSaveController = useMemo<
    ClientConfigSaveController<ProjectConnectionConfigDraft>
  >(
    () => ({
      beginSave: ({ projectId, savedConfig, awaitRemoteEcho }) => {
        const state = useClientConfigStore.getState();
        if (!canApplyStoreSaveState(state.activeProjectId, projectId)) {
          return;
        }

        useClientConfigStore.getState().beginSave({
          projectId,
          savedConfig,
          awaitRemoteEcho,
        });
      },
      markSaved: ({ projectId, savedConfig, awaitRemoteEcho }) => {
        const state = useClientConfigStore.getState();
        if (!canApplyStoreSaveState(state.activeProjectId, projectId)) {
          return;
        }
        if (
          awaitRemoteEcho &&
          (state.pendingProjectId !== projectId ||
            stableStringifyJson(state.pendingSavedConfig) !==
              stableStringifyJson(savedConfig))
        ) {
          return;
        }

        useClientConfigStore.getState().markSaved(savedConfig);
      },
      failSave: ({ projectId, savedConfig, awaitRemoteEcho }) => {
        const state = useClientConfigStore.getState();
        if (!canApplyStoreSaveState(state.activeProjectId, projectId)) {
          return;
        }
        if (
          awaitRemoteEcho &&
          (state.pendingProjectId !== projectId ||
            stableStringifyJson(state.pendingSavedConfig) !==
              stableStringifyJson(savedConfig))
        ) {
          return;
        }

        useClientConfigStore.getState().failSave();
      },
    }),
    [],
  );

  const hostContextSaveController = useMemo<
    ClientConfigSaveController<ProjectHostContextDraft>
  >(
    () => ({
      beginSave: ({ projectId, savedConfig, awaitRemoteEcho }) => {
        const state = useHostContextStore.getState();
        if (!canApplyStoreSaveState(state.activeProjectId, projectId)) {
          return;
        }

        useHostContextStore.getState().beginSave({
          projectId,
          savedHostContext: savedConfig,
          awaitRemoteEcho,
        });
      },
      markSaved: ({ projectId, savedConfig, awaitRemoteEcho }) => {
        const state = useHostContextStore.getState();
        if (!canApplyStoreSaveState(state.activeProjectId, projectId)) {
          return;
        }
        if (
          awaitRemoteEcho &&
          (state.pendingProjectId !== projectId ||
            stableStringifyJson(state.pendingSavedHostContext) !==
              stableStringifyJson(savedConfig))
        ) {
          return;
        }

        useHostContextStore.getState().markSaved(savedConfig);
      },
      failSave: ({ projectId, savedConfig, awaitRemoteEcho }) => {
        const state = useHostContextStore.getState();
        if (!canApplyStoreSaveState(state.activeProjectId, projectId)) {
          return;
        }
        if (
          awaitRemoteEcho &&
          (state.pendingProjectId !== projectId ||
            stableStringifyJson(state.pendingSavedHostContext) !==
              stableStringifyJson(savedConfig))
        ) {
          return;
        }

        useHostContextStore.getState().failSave();
      },
    }),
    [],
  );

  const handleUpdateClientConfig = useCallback(
    async (
      projectId: string,
      connectionConfig: ProjectConnectionConfigDraft | undefined,
    ): Promise<void> => {
      const clientConfigStore = useClientConfigStore.getState();
      const scopedDraftConfig = doesStoreSliceBelongToProject(
        clientConfigStore.activeProjectId,
        projectId,
      )
        ? clientConfigStore.draftConfig
        : undefined;
      const connectionConfigToPersist =
        connectionConfig ??
        scopedDraftConfig ??
        resolvePersistedConnectionConfig(projectId);

      await persistProjectClientConfig({
        projectId,
        slice: {
          kind: "connection",
          connectionConfig: connectionConfigToPersist,
        },
        savedSlice: connectionConfigToPersist,
        controller: connectionConfigSaveController,
      });
    },
    [
      connectionConfigSaveController,
      persistProjectClientConfig,
      resolvePersistedConnectionConfig,
    ],
  );

  const handleUpdateHostContext = useCallback(
    async (
      projectId: string,
      hostContext: ProjectHostContextDraft | undefined,
    ): Promise<void> => {
      const hostContextStore = useHostContextStore.getState();
      const scopedDraftHostContext = doesStoreSliceBelongToProject(
        hostContextStore.activeProjectId,
        projectId,
      )
        ? hostContextStore.draftHostContext
        : undefined;
      const hostContextToPersist =
        hostContext ??
        scopedDraftHostContext ??
        resolvePersistedHostContext(projectId);

      await persistProjectClientConfig({
        projectId,
        slice: { kind: "hostContext", hostContext: hostContextToPersist },
        savedSlice: hostContextToPersist,
        controller: hostContextSaveController,
      });
    },
    [
      hostContextSaveController,
      persistProjectClientConfig,
      resolvePersistedHostContext,
    ],
  );

  const handleDeleteProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      // If deleting the active project, switch to another first
      if (projectId === effectiveActiveProjectId) {
        const otherProjectIds = Object.keys(effectiveProjects).filter(
          (id) => id !== projectId,
        );
        const defaultProject = otherProjectIds.find(
          (id) => effectiveProjects[id].isDefault,
        );
        const targetProjectId = defaultProject || otherProjectIds[0];

        if (!targetProjectId) {
          toast.error("Cannot delete the only project");
          return false;
        }

        if (isAuthenticated && !shouldUseLocalFallback) {
          setConvexActiveProjectId(targetProjectId);
        } else {
          dispatch({
            type: "SWITCH_PROJECT",
            projectId: targetProjectId,
          });
        }
      }

      if (isAuthenticated && !shouldUseLocalFallback) {
        try {
          await convexDeleteProject({ projectId });
        } catch (error) {
          let errorMessage = "Failed to delete project";
          if (
            error &&
            typeof error === "object" &&
            "data" in error &&
            typeof (error as { data: unknown }).data === "string"
          ) {
            errorMessage = (error as { data: string }).data;
          } else if (error instanceof Error) {
            const match = error.message.match(/Uncaught Error: (.+?)(?:\n|$)/);
            errorMessage = match ? match[1] : error.message;
          }
          logger.error("Failed to delete project from Convex", {
            error: errorMessage,
          });
          toast.error(errorMessage);
          return false;
        }
        toast.success("Project deleted");
      } else {
        dispatch({ type: "DELETE_PROJECT", projectId });
        toast.success("Project deleted");
      }
      return true;
    },
    [
      effectiveActiveProjectId,
      effectiveProjects,
      isAuthenticated,
      shouldUseLocalFallback,
      convexDeleteProject,
      setConvexActiveProjectId,
      logger,
      dispatch,
    ],
  );

  const handleDuplicateProject = useCallback(
    async (projectId: string, newName: string) => {
      const sourceProject = effectiveProjects[projectId];
      if (!sourceProject) {
        toast.error("Project not found");
        return;
      }

      if (isAuthenticated && !shouldUseLocalFallback) {
        const organizationId = projectOrganizationId;
        if (
          shouldTreatRemoteProjectsAsEmpty ||
          !hasResolvedProjectOrganizationSelection ||
          organizationId === undefined
        ) {
          toast.error("Create or join an organization to create projects.");
          return;
        }
        try {
          const serializedServers = serializeServersForSharing(
            sourceProject.servers,
          );
          const bulkForSource = bulkServersByProject[sourceProject.id];
          assertNotColdSharingEmptyServers({
            callSite: "duplicate",
            sourceProjectId: sourceProject.id,
            serializedServerCount: Object.keys(serializedServers).length,
            bulkServerCount: bulkForSource ? bulkForSource.length : null,
            embeddedServerCount: Object.keys(sourceProject.servers ?? {}).length,
          });
          await convexCreateProject({
            name: newName,
            description: sourceProject.description,
            clientConfig: sourceProject.clientConfig,
            servers: serializedServers,
            organizationId,
          });
          toast.success(`Project duplicated as "${newName}"`);
        } catch (error) {
          toast.error(
            getBillingErrorMessage(
              error,
              "Failed to duplicate project",
              canManageBillingForProjectActions,
            ),
          );
        }
      } else {
        if (
          isAuthenticated &&
          (!hasResolvedProjectOrganizationSelection ||
            projectOrganizationId === undefined)
        ) {
          toast.error("Create or join an organization to create projects.");
          return;
        }

        const duplicatedProject: Project = {
          ...sourceProject,
          id: createLocalProjectId(),
          name: newName,
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: false,
          organizationId: isAuthenticated
            ? projectOrganizationId
            : sourceProject.organizationId,
        };
        dispatch({ type: "CREATE_PROJECT", project: duplicatedProject });
        toast.success(`Project duplicated as "${newName}"`);
      }
    },
    [
      effectiveProjects,
      isAuthenticated,
      shouldUseLocalFallback,
      shouldTreatRemoteProjectsAsEmpty,
      convexCreateProject,
      dispatch,
      projectOrganizationId,
      hasResolvedProjectOrganizationSelection,
      canManageBillingForProjectActions,
      bulkServersByProject,
    ],
  );

  const handleSetDefaultProject = useCallback(
    (projectId: string) => {
      dispatch({ type: "SET_DEFAULT_PROJECT", projectId });
      toast.success("Default project updated");
    },
    [dispatch],
  );

  const handleProjectShared = useCallback(
    (convexProjectId: string, sourceProjectId?: string) => {
      const resolvedSourceProjectId =
        sourceProjectId ?? appState.activeProjectId;
      const shouldKeepActiveProject =
        resolvedSourceProjectId === appState.activeProjectId;

      if (isAuthenticated) {
        if (appState.projects[resolvedSourceProjectId]) {
          dispatch({
            type: "UPDATE_PROJECT",
            projectId: resolvedSourceProjectId,
            updates: { sharedProjectId: convexProjectId },
          });
        }

        if (shouldKeepActiveProject) {
          setConvexActiveProjectId(convexProjectId);
        }

        logger.info("Project shared", {
          convexProjectId,
          sourceProjectId,
          switchedActiveProject: shouldKeepActiveProject,
        });
      } else {
        dispatch({
          type: "UPDATE_PROJECT",
          projectId: resolvedSourceProjectId,
          updates: { sharedProjectId: convexProjectId },
        });
      }
    },
    [
      isAuthenticated,
      logger,
      dispatch,
      appState.activeProjectId,
      appState.projects,
    ],
  );

  const handleExportProject = useCallback(
    (projectId: string) => {
      const project = effectiveProjects[projectId];
      if (!project) {
        toast.error("Project not found");
        return;
      }

      const dataStr = JSON.stringify(project, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.name.replace(/\s+/g, "_")}_project.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Project exported");
    },
    [effectiveProjects],
  );

  const handleImportProject = useCallback(
    async (projectData: Project) => {
      if (isAuthenticated && !shouldUseLocalFallback) {
        const organizationId = projectOrganizationId;
        if (
          shouldTreatRemoteProjectsAsEmpty ||
          !hasResolvedProjectOrganizationSelection ||
          organizationId === undefined
        ) {
          toast.error("Create or join an organization to create projects.");
          return;
        }
        try {
          const serializedServers = serializeServersForSharing(
            projectData.servers || {},
          );
          assertNotColdSharingEmptyServers({
            callSite: "import",
            sourceProjectId: projectData.id ?? "<unknown-import>",
            serializedServerCount: Object.keys(serializedServers).length,
            // Import-from-JSON has no bulk-query source — the user pasted
            // the payload. We only have the embedded count to compare.
            bulkServerCount: null,
            embeddedServerCount: Object.keys(projectData.servers ?? {}).length,
          });
          await convexCreateProject({
            name: projectData.name,
            description: projectData.description,
            clientConfig: projectData.clientConfig,
            servers: serializedServers,
            organizationId,
          });
          toast.success(`Project "${projectData.name}" imported`);
        } catch (error) {
          toast.error(
            getBillingErrorMessage(
              error,
              "Failed to import project",
              canManageBillingForProjectActions,
            ),
          );
        }
      } else {
        if (
          isAuthenticated &&
          (!hasResolvedProjectOrganizationSelection ||
            projectOrganizationId === undefined)
        ) {
          toast.error("Create or join an organization to create projects.");
          return;
        }
        const importedProject: Project = {
          ...projectData,
          id: createLocalProjectId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: false,
          organizationId: isAuthenticated
            ? projectOrganizationId
            : projectData.organizationId,
        };
        dispatch({ type: "IMPORT_PROJECT", project: importedProject });
        toast.success(`Project "${importedProject.name}" imported`);
      }
    },
    [
      isAuthenticated,
      shouldUseLocalFallback,
      shouldTreatRemoteProjectsAsEmpty,
      convexCreateProject,
      dispatch,
      projectOrganizationId,
      hasResolvedProjectOrganizationSelection,
      canManageBillingForProjectActions,
    ],
  );

  return {
    remoteProjects,
    isLoadingProjects,
    activeProjectServersFlat,
    // True while the bulk server query is in flight for the picker's
    // non-active projects. Consumers (e.g. ProjectManagementDialog) gate
    // the "{n} server(s)" label on this so it never flashes "0 server(s)"
    // before the bulk query resolves. The active project ignores this flag
    // — its count comes from the existing flat single-project query.
    isLoadingBulkServers,
    bulkServersByProject,
    // Always false — kept on the return shape so existing consumers
    // (tests, App.tsx) don't break in this PR. Convex-unreachable now
    // surfaces through the existing loading-skeleton path; no separate
    // signal needed.
    useLocalFallback: shouldUseLocalFallback,
    setConvexActiveProjectId,
    clearConvexActiveProjectSelection,
    isLoadingRemoteProjects,
    effectiveProjects,
    effectiveActiveProjectId,
    handleCreateProject,
    handleUpdateProject,
    handleUpdateClientConfig,
    handleUpdateHostContext,
    handleDeleteProject,
    handleDuplicateProject,
    handleSetDefaultProject,
    handleProjectShared,
    handleExportProject,
    handleImportProject,
  };
}
