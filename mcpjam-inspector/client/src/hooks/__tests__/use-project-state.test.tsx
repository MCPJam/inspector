import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { AppAction, AppState, Project } from "@/state/app-types";
import { useProjectState } from "../use-project-state";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/client-context-store";
import type {
  ProjectClientConfig,
  ProjectConnectionConfigDraft,
  ProjectHostContextDraft,
} from "@/lib/client-config";

const {
  createProjectMock,
  ensureDefaultProjectMock,
  patchProjectDefaultConnectionMock,
  updateProjectMock,
  deleteProjectMock,
  projectQueryState,
  projectServersState,
  projectsBulkServersState,
  emitEmbeddedBlobReadMock,
  sentryCaptureMessageMock,
  organizationBillingStatusState,
  useOrganizationBillingStatusMock,
  serializeServersForSharingMock,
} = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  ensureDefaultProjectMock: vi.fn(),
  patchProjectDefaultConnectionMock: vi.fn(),
  updateProjectMock: vi.fn(),
  deleteProjectMock: vi.fn(),
  projectQueryState: {
    allProjects: undefined as any,
    projects: undefined as any,
    isLoading: false,
  },
  projectServersState: {
    servers: undefined as any,
    isLoading: false as boolean,
  },
  projectsBulkServersState: {
    serversByProject: {} as Record<string, any[]>,
    isLoading: false as boolean,
  },
  emitEmbeddedBlobReadMock: vi.fn(),
  sentryCaptureMessageMock: vi.fn(),
  organizationBillingStatusState: {
    value: undefined as
      | {
          canManageBilling: boolean;
        }
      | undefined,
  },
  useOrganizationBillingStatusMock: vi.fn(),
  serializeServersForSharingMock: vi.fn((servers) => servers),
}));

vi.mock("@sentry/react", () => ({
  captureMessage: sentryCaptureMessageMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../useProjects", () => ({
  useProjectQueries: () => projectQueryState,
  useProjectMutations: () => ({
    createProject: createProjectMock,
    ensureDefaultProject: ensureDefaultProjectMock,
    updateProject: updateProjectMock,
    patchProjectDefaultConnection: patchProjectDefaultConnectionMock,
    deleteProject: deleteProjectMock,
  }),
  useProjectServers: () => projectServersState,
  useProjectsBulkServers: () => projectsBulkServersState,
}));

vi.mock("../useClientTelemetry", () => ({
  useEmbeddedBlobReadTelemetry: () => emitEmbeddedBlobReadMock,
}));

vi.mock("../useOrganizationBilling", () => ({
  useOrganizationBillingStatus: (...args: unknown[]) =>
    useOrganizationBillingStatusMock(...args),
}));

vi.mock("@/lib/project-serialization", () => ({
  deserializeServersFromConvex: vi.fn((servers) => {
    if (Array.isArray(servers)) {
      return Object.fromEntries(
        (servers as Array<{ name: string }>).map((s) => [s.name, s]),
      );
    }
    return servers ?? {};
  }),
  serializeServersForSharing: serializeServersForSharingMock,
}));

function createSyntheticDefaultProject(): Project {
  return {
    id: "default",
    name: "Default",
    description: "Default project",
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    isDefault: true,
  };
}

function createLocalProject(
  id: string,
  overrides: Partial<Project> = {},
): Project {
  return {
    id,
    name: `Project ${id}`,
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createAppState(projects: Record<string, Project>): AppState {
  const firstProjectId = Object.keys(projects)[0] ?? "none";
  return {
    projects,
    activeProjectId: firstProjectId,
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

function renderUseProjectState({
  appState,
  activeOrganizationId,
  routeOrganizationId,
  isAuthenticated = true,
  isUserReady = isAuthenticated,
  hasOrganizations = true,
  isLoadingOrganizations = false,
  validOrganizationIds,
  hasSignedInUser = true,
  currentActorKey = "test-actor",
}: {
  appState: AppState;
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  isAuthenticated?: boolean;
  isUserReady?: boolean;
  hasOrganizations?: boolean;
  isLoadingOrganizations?: boolean;
  validOrganizationIds?: string[];
  hasSignedInUser?: boolean;
  currentActorKey?: string | null;
}) {
  const dispatch = vi.fn<(action: AppAction) => void>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const result = renderHook(
    ({
      organizationId,
      hasOrganizationsOverride,
      isLoadingOrganizationsOverride,
      routeOrganizationIdOverride,
      validOrganizationIdsOverride,
    }: {
      organizationId?: string;
      hasOrganizationsOverride?: boolean;
      isLoadingOrganizationsOverride?: boolean;
      routeOrganizationIdOverride?: string;
      validOrganizationIdsOverride?: string[];
    }) =>
      useProjectState({
        appState,
        dispatch,
        isAuthenticated,
        isUserReady,
        isAuthLoading: false,
        hasOrganizations: hasOrganizationsOverride ?? hasOrganizations,
        isLoadingOrganizations:
          isLoadingOrganizationsOverride ?? isLoadingOrganizations,
        validOrganizationIds:
          validOrganizationIdsOverride ??
          validOrganizationIds ??
          [
            routeOrganizationIdOverride ?? routeOrganizationId,
            organizationId,
          ].filter(
            (organizationId): organizationId is string => !!organizationId,
          ),
        activeOrganizationId: organizationId,
        routeOrganizationId: routeOrganizationIdOverride ?? routeOrganizationId,
        currentActorKey,
        hasSignedInUser,
        logger,
      }),
    {
      initialProps: {
        organizationId: activeOrganizationId,
        hasOrganizationsOverride: hasOrganizations,
        isLoadingOrganizationsOverride: isLoadingOrganizations,
        routeOrganizationIdOverride: routeOrganizationId,
        validOrganizationIdsOverride: validOrganizationIds,
      },
    },
  );

  return {
    ...result,
    dispatch,
    logger,
  };
}

describe("useProjectState automatic project creation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    createProjectMock.mockResolvedValue("remote-project-id");
    ensureDefaultProjectMock.mockResolvedValue("default-project-id");
    patchProjectDefaultConnectionMock.mockResolvedValue(undefined);
    updateProjectMock.mockResolvedValue("remote-project-id");
    deleteProjectMock.mockResolvedValue(undefined);
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];
    projectQueryState.isLoading = false;
    projectServersState.servers = undefined;
    projectServersState.isLoading = false;
    organizationBillingStatusState.value = undefined;
    useOrganizationBillingStatusMock.mockImplementation(
      () => organizationBillingStatusState.value,
    );
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      clientCapabilitiesError: null,
      connectionDefaultsError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
  });

  it("ensures one initial project per empty organization and dedupes rerenders", async () => {
    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Existing project",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { rerender } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-b",
    });

    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledTimes(1);
    });

    expect(ensureDefaultProjectMock).toHaveBeenLastCalledWith({
      organizationId: "org-b",
    });
    expect(createProjectMock).not.toHaveBeenCalled();

    rerender({ organizationId: "org-b" });
    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledTimes(1);
    });

    rerender({ organizationId: "org-c" });
    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledTimes(2);
    });

    expect(ensureDefaultProjectMock).toHaveBeenLastCalledWith({
      organizationId: "org-c",
    });
  });

  it("skips organization billing status queries while Convex auth is unavailable", () => {
    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });

    renderUseProjectState({
      appState,
      activeOrganizationId: "org-auth",
      isAuthenticated: false,
    });

    expect(useOrganizationBillingStatusMock).toHaveBeenCalledWith("org-auth", {
      enabled: false,
    });
  });

  it("skips organization billing status queries for a stale stored org", () => {
    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });

    renderUseProjectState({
      appState,
      activeOrganizationId: "org-stale",
      validOrganizationIds: ["org-live"],
    });

    expect(useOrganizationBillingStatusMock).toHaveBeenCalledWith(null, {
      enabled: true,
    });
  });

  it("prefers the route organization for project actions while active org state catches up", async () => {
    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Existing project",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-stale",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-stale",
      routeOrganizationId: "org-route",
    });

    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledWith({
        organizationId: "org-route",
      });
    });

    await act(async () => {
      await result.current.handleCreateProject("Project Two");
    });

    expect(createProjectMock).toHaveBeenCalledWith({
      organizationId: "org-route",
      name: "Project Two",
      clientConfig: undefined,
      servers: {},
    });
  });

  it("does not ensure a default project until organization selection resolves", async () => {
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { rerender } = renderUseProjectState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {});
    expect(ensureDefaultProjectMock).not.toHaveBeenCalled();

    rerender({
      organizationId: "org-live",
      hasOrganizationsOverride: true,
      isLoadingOrganizationsOverride: false,
      routeOrganizationIdOverride: undefined,
      validOrganizationIdsOverride: ["org-live"],
    });

    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledWith({
        organizationId: "org-live",
      });
    });
  });

  it("does not migrate local projects until organization selection resolves", async () => {
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
      "local-1": createLocalProject("local-1", {
        name: "Imported project",
        organizationId: "org-live",
      }),
    });
    const { rerender } = renderUseProjectState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {});
    expect(createProjectMock).not.toHaveBeenCalled();

    rerender({
      organizationId: "org-live",
      hasOrganizationsOverride: true,
      isLoadingOrganizationsOverride: false,
      routeOrganizationIdOverride: undefined,
      validOrganizationIdsOverride: ["org-live"],
    });

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        organizationId: "org-live",
        name: "Imported project",
        description: undefined,
        clientConfig: undefined,
        servers: {},
      });
    });
  });

  it("does not create a cloud project until organization selection resolves", async () => {
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {
      await result.current.handleCreateProject("Project Two");
    });

    expect(createProjectMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Create or join an organization to create projects.",
    );
  });

  it("does not duplicate a cloud project until organization selection resolves", async () => {
    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Project One",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-pending",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {
      await result.current.handleDuplicateProject(
        "remote-1",
        "Project Copy",
      );
    });

    expect(createProjectMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Create or join an organization to create projects.",
    );
  });

  it("does not import a cloud project until organization selection resolves", async () => {
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {
      await result.current.handleImportProject(
        createLocalProject("import-1", {
          name: "Imported Project",
        }),
      );
    });

    expect(createProjectMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Create or join an organization to create projects.",
    );
  });

  it("migrates real local projects with createProject and persists the shared project id", async () => {
    const appState = createAppState({
      default: createSyntheticDefaultProject(),
      "local-1": createLocalProject("local-1", {
        name: "Imported project",
        description: "Needs migration",
        organizationId: "org-migrate",
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { dispatch } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-migrate",
    });

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledTimes(1);
    });

    expect(serializeServersForSharingMock).toHaveBeenCalledWith(
      appState.projects["local-1"].servers,
    );
    expect(createProjectMock).toHaveBeenCalledWith({
      organizationId: "org-migrate",
      name: "Imported project",
      description: "Needs migration",
      servers: appState.projects["local-1"].servers,
    });
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_PROJECT",
        projectId: "local-1",
        updates: {
          sharedProjectId: "remote-project-id",
          organizationId: "org-migrate",
        },
      });
    });
    expect(ensureDefaultProjectMock).not.toHaveBeenCalled();
  });

  it("treats the empty synthetic default as ensure-default only, not a migration candidate", async () => {
    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { rerender } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-empty",
    });

    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledTimes(1);
    });

    expect(ensureDefaultProjectMock).toHaveBeenCalledWith({
      organizationId: "org-empty",
    });
    expect(serializeServersForSharingMock).not.toHaveBeenCalled();
    expect(createProjectMock).not.toHaveBeenCalled();

    rerender({ organizationId: "org-empty" });
    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledTimes(1);
    });
  });

  it("authenticated client-config saves resolve as soon as the v2 mutation returns", async () => {
    // Phase 4: writes go through hostConfigsV2.patchProjectDefaultConnection.
    // The mutation is awaited and the v2 row is the canonical write
    // target, so the save resolves immediately on mutation completion —
    // no project-doc echo round-trip.
    const savedConfig: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: {},
        requestTimeout: 10000,
      },
      clientCapabilities: {
        experimental: {
          inspectorProfile: true,
        },
      },
    };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({ appState });

    await result.current.handleUpdateClientConfig("remote-1", savedConfig);

    // Connection-only saves leave hostContext untouched on the backend
    // by passing `undefined` (P2): the v2 patcher merges only the
    // fields it receives.
    expect(patchProjectDefaultConnectionMock).toHaveBeenCalledWith({
      projectId: "remote-1",
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: savedConfig.clientCapabilities,
      hostContext: undefined,
    });
    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(false);
    expect(useClientConfigStore.getState().isSaving).toBe(false);
  });

  it("sends only the host-context slice on host-context saves so connection settings are not clobbered", async () => {
    const remoteOneClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: {
        headers: { "x-project": "one" },
        requestTimeout: 1111,
      },
      clientCapabilities: {
        experimental: {
          projectOne: true,
        },
      },
      hostContext: {
        locale: "en-US",
      },
    };
    const remoteTwoClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: {
        headers: { "x-project": "two" },
        requestTimeout: 2222,
      },
      clientCapabilities: {
        experimental: {
          projectTwo: true,
        },
      },
      hostContext: {
        locale: "en-GB",
      },
    };
    const savedHostContext: ProjectHostContextDraft = {
      theme: "dark",
    };
    const expectedPersistedClientConfig: ProjectClientConfig = {
      ...remoteTwoClientConfig,
      hostContext: savedHostContext,
    };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project 1",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: remoteOneClientConfig,
      },
      {
        _id: "remote-2",
        name: "Remote project 2",
        servers: {},
        ownerId: "user-1",
        createdAt: 2,
        updatedAt: 2,
        clientConfig: remoteTwoClientConfig,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");
    useClientConfigStore.setState({
      activeProjectId: "remote-1",
      savedConfig: {
        version: 1,
        connectionDefaults: {
          headers: { "x-project": "stale" },
          requestTimeout: 9999,
        },
        clientCapabilities: {
          experimental: {
            stale: true,
          },
        },
      },
      defaultConfig: null,
      draftConfig: {
        version: 1,
        connectionDefaults: {
          headers: { "x-project": "draft" },
          requestTimeout: 7777,
        },
        clientCapabilities: {
          experimental: {
            draft: true,
          },
        },
      },
    });

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({ appState });

    await result.current.handleUpdateHostContext("remote-2", savedHostContext);

    // P2: host-context saves send only the hostContext slice. The
    // backend helper preserves connectionDefaults / clientCapabilities
    // when those fields are undefined, so a slow connection save can
    // no longer overwrite them.
    expect(patchProjectDefaultConnectionMock).toHaveBeenCalledWith({
      projectId: "remote-2",
      connectionDefaults: undefined,
      clientCapabilities: undefined,
      hostContext: savedHostContext,
    });
    // expectedPersistedClientConfig is referenced here purely as a
    // sanity check that the test setup composes a recognizable
    // post-save shape; the wire format itself is the per-slice patch
    // asserted above.
    expect(expectedPersistedClientConfig.hostContext).toEqual(
      savedHostContext,
    );
  });

  it("sends only the connection slice on connection saves so host context is not clobbered", async () => {
    const remoteOneClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: {
        headers: { "x-project": "one" },
        requestTimeout: 1111,
      },
      clientCapabilities: {
        experimental: {
          projectOne: true,
        },
      },
      hostContext: {
        locale: "en-US",
      },
    };
    const remoteTwoHostContext: ProjectHostContextDraft = {
      locale: "en-GB",
      theme: "light",
    };
    const remoteTwoClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: {
        headers: { "x-project": "two" },
        requestTimeout: 2222,
      },
      clientCapabilities: {
        experimental: {
          projectTwo: true,
        },
      },
      hostContext: remoteTwoHostContext,
    };
    const savedConnectionConfig: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: { "x-project": "updated" },
        requestTimeout: 3333,
      },
      clientCapabilities: {
        experimental: {
          updated: true,
        },
      },
    };
    const expectedPersistedClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: savedConnectionConfig.connectionDefaults,
      clientCapabilities: savedConnectionConfig.clientCapabilities,
      hostContext: remoteTwoHostContext,
    };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project 1",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: remoteOneClientConfig,
      },
      {
        _id: "remote-2",
        name: "Remote project 2",
        servers: {},
        ownerId: "user-1",
        createdAt: 2,
        updatedAt: 2,
        clientConfig: remoteTwoClientConfig,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");
    useHostContextStore.setState({
      activeProjectId: "remote-1",
      savedHostContext: {
        locale: "stale-locale",
        theme: "dark",
      },
      defaultHostContext: {},
      draftHostContext: {
        locale: "draft-locale",
        theme: "dark",
      },
    });

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({ appState });

    await result.current.handleUpdateClientConfig(
      "remote-2",
      savedConnectionConfig,
    );

    // P2: connection saves send only the connection slice. The
    // backend helper preserves hostContext when undefined, so a slow
    // host-context save can no longer overwrite it.
    expect(patchProjectDefaultConnectionMock).toHaveBeenCalledWith({
      projectId: "remote-2",
      connectionDefaults: savedConnectionConfig.connectionDefaults,
      clientCapabilities: savedConnectionConfig.clientCapabilities,
      hostContext: undefined,
    });
    expect(expectedPersistedClientConfig.hostContext).toEqual(
      remoteTwoHostContext,
    );
  });

  it("calls the v2 patcher once per save and resolves each independently", async () => {
    // Phase 4: writes go directly through the v2 mutation; the legacy
    // echo-pending pattern (which gated newer saves on older saves
    // timing out) no longer applies. Each save resolves on its own
    // mutation completion.
    const firstSavedConfig: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: { "x-project": "one" },
        requestTimeout: 1111,
      },
      clientCapabilities: {
        experimental: {
          projectOne: true,
        },
      },
    };
    const secondSavedConfig: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: { "x-project": "two" },
        requestTimeout: 2222,
      },
      clientCapabilities: {
        experimental: {
          projectTwo: true,
        },
      },
    };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project 1",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
      {
        _id: "remote-2",
        name: "Remote project 2",
        servers: {},
        ownerId: "user-1",
        createdAt: 2,
        updatedAt: 2,
        clientConfig: undefined,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({ appState });

    await result.current.handleUpdateClientConfig("remote-1", firstSavedConfig);
    await result.current.handleUpdateClientConfig("remote-2", secondSavedConfig);

    expect(patchProjectDefaultConnectionMock).toHaveBeenCalledTimes(2);
    expect(patchProjectDefaultConnectionMock).toHaveBeenNthCalledWith(1, {
      projectId: "remote-1",
      connectionDefaults: firstSavedConfig.connectionDefaults,
      clientCapabilities: firstSavedConfig.clientCapabilities,
      hostContext: undefined,
    });
    expect(patchProjectDefaultConnectionMock).toHaveBeenNthCalledWith(2, {
      projectId: "remote-2",
      connectionDefaults: secondSavedConfig.connectionDefaults,
      clientCapabilities: secondSavedConfig.clientCapabilities,
      hostContext: undefined,
    });
  });

  it("treats the authenticated zero-org state as empty remote projects and clears stale synced selection", async () => {
    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Deleted org project",
        servers: {},
        ownerId: "user-1",
        organizationId: "deleted-org",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: false,
      isLoadingOrganizations: false,
    });

    await waitFor(() => {
      expect(result.current.effectiveProjects).toEqual({});
      expect(result.current.effectiveActiveProjectId).toBe("none");
    });

    expect(localStorage.getItem("convex-active-project-id")).toBeNull();
    expect(ensureDefaultProjectMock).not.toHaveBeenCalled();
  });

  it("keeps unauthenticated local projects visible without org scoping", () => {
    const appState = createAppState({
      "local-unscoped": createLocalProject("local-unscoped"),
      "local-org-b": createLocalProject("local-org-b", {
        organizationId: "org-b",
      }),
    });

    const { result } = renderUseProjectState({
      appState,
      isAuthenticated: false,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    expect(result.current.effectiveProjects).toEqual(appState.projects);
    expect(result.current.effectiveActiveProjectId).toBe(
      appState.activeProjectId,
    );
  });

  it("does not render local app-state projects for authenticated Convex orgs", () => {
    projectQueryState.allProjects = [
      {
        _id: "convex-org-a",
        name: "Convex Org A",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: "convex-org-b",
        name: "Convex Org B",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-b",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    projectQueryState.projects = [projectQueryState.allProjects[1]];

    const appState = createAppState({
      "local-org-b": createLocalProject("local-org-b", {
        organizationId: "org-b",
      }),
    });

    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-b",
      validOrganizationIds: ["org-a", "org-b"],
    });

    expect(Object.keys(result.current.effectiveProjects)).toEqual([
      "convex-org-b",
    ]);
    expect(result.current.effectiveProjects["local-org-b"]).toBeUndefined();
  });

  it("does not migrate local projects from another org into the current organization", async () => {
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
      "local-org-b": createLocalProject("local-org-b", {
        name: "Org B project",
        organizationId: "org-b",
      }),
    });

    renderUseProjectState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a", "org-b"],
    });

    await waitFor(() => {
      expect(ensureDefaultProjectMock).toHaveBeenCalledWith({
        organizationId: "org-a",
      });
    });

    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("propagates v2 mutation errors and clears saving state", async () => {
    // Phase 4: when the v2 patcher rejects, the save promise rejects
    // with the mutation's error and the store's isSaving / pendingProjectId
    // both clear. The legacy echo timeout no longer applies.
    const savedConfig: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: {},
        requestTimeout: 10000,
      },
      clientCapabilities: {
        experimental: {
          inspectorProfile: true,
        },
      },
    };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");

    patchProjectDefaultConnectionMock.mockRejectedValueOnce(
      new Error("backend exploded"),
    );

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({ appState });

    await expect(
      result.current.handleUpdateClientConfig("remote-1", savedConfig),
    ).rejects.toThrow("backend exploded");
    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(false);
    expect(useClientConfigStore.getState().isSaving).toBe(false);
  });

  it("interleaved connection and host-context saves do not clobber each other", async () => {
    // P2 regression: previously persistProjectClientConfig sent all
    // three sections (connectionDefaults / clientCapabilities /
    // hostContext) on every save and dispatched a full clientConfig
    // optimistically. A slow connection save resolving after a fast
    // host-context save would overwrite the new hostContext both
    // remotely and locally. Now each save sends only its slice and
    // dispatches a slice-merge action.
    const initialClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: {
        headers: { "x-initial": "yes" },
        requestTimeout: 1000,
      },
      clientCapabilities: { initial: true },
      hostContext: { theme: "light" },
    };
    const newConnection: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: { "x-new": "yes" },
        requestTimeout: 2000,
      },
      clientCapabilities: { updated: true },
    };
    const newHostContext: ProjectHostContextDraft = { theme: "dark" };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: initialClientConfig,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");

    let resolveSlowConnectionSave!: () => void;
    patchProjectDefaultConnectionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSlowConnectionSave = resolve;
        }),
    );
    patchProjectDefaultConnectionMock.mockResolvedValueOnce(undefined);

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result, dispatch } = renderUseProjectState({ appState });

    // Kick off the slow connection save first (don't await).
    const slowConnectionSave = result.current.handleUpdateClientConfig(
      "remote-1",
      newConnection,
    );
    // Then complete a host-context save while the connection save is
    // still pending.
    await result.current.handleUpdateHostContext("remote-1", newHostContext);
    // Finally let the slow connection save resolve.
    resolveSlowConnectionSave();
    await slowConnectionSave;

    // Wire format: each save sent only its own slice. The connection
    // save did NOT include hostContext, so the backend helper's
    // preserve-when-undefined merge keeps the new hostContext intact.
    expect(patchProjectDefaultConnectionMock).toHaveBeenCalledTimes(2);
    expect(patchProjectDefaultConnectionMock).toHaveBeenNthCalledWith(1, {
      projectId: "remote-1",
      connectionDefaults: newConnection.connectionDefaults,
      clientCapabilities: newConnection.clientCapabilities,
      hostContext: undefined,
    });
    expect(patchProjectDefaultConnectionMock).toHaveBeenNthCalledWith(2, {
      projectId: "remote-1",
      connectionDefaults: undefined,
      clientCapabilities: undefined,
      hostContext: newHostContext,
    });

    // Local optimistic dispatch: each save dispatched a slice-merge
    // action, never a full UPDATE_PROJECT { clientConfig: ... }. That's
    // what prevents the in-flight connection save from clobbering the
    // newly-saved hostContext locally when it eventually resolves.
    const sliceDispatches = dispatch.mock.calls
      .map(([action]) => action)
      .filter(
        (
          action,
        ): action is Extract<
          AppAction,
          { type: "UPDATE_PROJECT_CLIENT_CONFIG_SLICE" }
        > => action.type === "UPDATE_PROJECT_CLIENT_CONFIG_SLICE",
      );
    expect(sliceDispatches).toHaveLength(2);
    expect(sliceDispatches[0]).toMatchObject({
      projectId: "remote-1",
      slice: {
        kind: "hostContext",
        hostContext: newHostContext,
      },
    });
    expect(sliceDispatches[1]).toMatchObject({
      projectId: "remote-1",
      slice: {
        kind: "connection",
        connectionDefaults: newConnection.connectionDefaults,
        clientCapabilities: newConnection.clientCapabilities,
      },
    });
    // No call passed `updates: { clientConfig: ... }` — i.e. the full
    // overwrite path that previously clobbered sibling slices.
    const fullClientConfigDispatches = dispatch.mock.calls
      .map(([action]) => action)
      .filter(
        (action) =>
          action.type === "UPDATE_PROJECT" &&
          (action as Extract<AppAction, { type: "UPDATE_PROJECT" }>).updates
            .clientConfig !== undefined,
      );
    expect(fullClientConfigDispatches).toHaveLength(0);
  });

  it("connection saves with undefined connectionDefaults send explicit defaults so the backend doesn't preserve the old timeout", async () => {
    // CodeRabbit Major: previously the reset branch sent only
    // `headers: {}`. The backend's partial validator merges missing
    // requestTimeout from the existing default, so a draft with
    // `connectionDefaults: undefined` would have the user's old
    // timeout stick remotely while the optimistic local state showed
    // the default — drifting back on the next refetch.
    //
    // ProjectConnectionConfigDraft.connectionDefaults is optional, so
    // a draft can legally have it absent; the wire payload (and
    // optimistic dispatch) must in that case carry an explicit
    // { headers: {}, requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS }
    // rather than letting the backend preserve a stale value.
    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: {
          version: 1,
          connectionDefaults: {
            headers: { "x-custom": "yes" },
            requestTimeout: 99_999,
          },
          clientCapabilities: { customCap: true },
          hostContext: {},
        },
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result, dispatch } = renderUseProjectState({ appState });

    const draftWithoutConnectionDefaults: ProjectConnectionConfigDraft = {
      version: 1,
      clientCapabilities: { newCap: true },
    };
    await result.current.handleUpdateClientConfig(
      "remote-1",
      draftWithoutConnectionDefaults,
    );

    // Wire payload carries explicit defaults — the backend's
    // preserve-when-undefined merge can't fall back to 99_999.
    expect(patchProjectDefaultConnectionMock).toHaveBeenCalledWith({
      projectId: "remote-1",
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: { newCap: true },
      hostContext: undefined,
    });

    // Optimistic dispatch matches the wire payload — local state
    // doesn't drift between save and the next refetch.
    const sliceDispatch = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (
          action,
        ): action is Extract<
          AppAction,
          { type: "UPDATE_PROJECT_CLIENT_CONFIG_SLICE" }
        > => action.type === "UPDATE_PROJECT_CLIENT_CONFIG_SLICE",
      );
    expect(sliceDispatch).toMatchObject({
      projectId: "remote-1",
      slice: {
        kind: "connection",
        connectionDefaults: { headers: {}, requestTimeout: 10000 },
        clientCapabilities: { newCap: true },
      },
    });
  });

  it("gates connect / reconnect paths via isAwaitingRemoteEcho while the v2 mutation is in flight", async () => {
    // Codex P2: setting awaitRemoteEcho:false on beginSave previously
    // left useProjectClientConfigSyncPending() returning false during
    // the network round-trip, so assertClientConfigSynced /
    // notifyIfClientConfigSyncPending in use-server-state would not
    // gate connect/test/resolver paths and a reconnect could read the
    // stale activeProject.clientConfig (the optimistic dispatch only
    // fires after the await resolves).
    const savedConfig: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: { headers: {}, requestTimeout: 5_000 },
      clientCapabilities: {},
    };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");

    let resolveSave!: () => void;
    patchProjectDefaultConnectionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({ appState });

    const inFlight = result.current.handleUpdateClientConfig(
      "remote-1",
      savedConfig,
    );

    // While the v2 mutation is in flight, the sync-pending guard is
    // active for the target project. assertClientConfigSynced /
    // notifyIfClientConfigSyncPending in use-server-state read off
    // exactly this state.
    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(true);
    expect(useClientConfigStore.getState().pendingProjectId).toBe("remote-1");
    expect(useClientConfigStore.getState().isSaving).toBe(true);

    resolveSave();
    await inFlight;

    // Once the mutation resolves we mark saved immediately — no
    // project-doc echo wait — so the gate releases.
    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(false);
    expect(useClientConfigStore.getState().pendingProjectId).toBeNull();
    expect(useClientConfigStore.getState().isSaving).toBe(false);
  });

  it("formats project create billing errors for organization owners", async () => {
    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Existing project",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-owner",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    organizationBillingStatusState.value = {
      canManageBilling: true,
    };
    createProjectMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxProjects",
          allowedValue: 1,
        }),
      ),
    );

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-owner",
    });

    await act(async () => {
      await result.current.handleCreateProject("Project Two");
    });

    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its project limit (1). Upgrade to create more projects.",
    );
  });

  it("formats project create billing errors for non-billing-admin members", async () => {
    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Existing project",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-member",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    organizationBillingStatusState.value = {
      canManageBilling: false,
    };
    createProjectMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxProjects",
          allowedValue: 1,
        }),
      ),
    );

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-member",
    });

    await act(async () => {
      await result.current.handleCreateProject("Project Two");
    });

    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its project limit (1). Ask an organization owner to upgrade.",
    );
  });

  it("shows only one toast when multiple local project migrations fail in the same burst", async () => {
    organizationBillingStatusState.value = {
      canManageBilling: false,
    };
    createProjectMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxProjects",
          allowedValue: 1,
        }),
      ),
    );

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
      "local-1": createLocalProject("local-1", {
        name: "Local One",
        organizationId: "org-member",
      }),
      "local-2": createLocalProject("local-2", {
        name: "Local Two",
        organizationId: "org-member",
      }),
    });
    const { logger } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-member",
    });

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledTimes(2);
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its project limit (1). Ask an organization owner to upgrade.",
    );
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("keeps the active project unchanged when sharing a different local project", async () => {
    const appState = createAppState({
      "project-a": createLocalProject("project-a", {
        name: "Project A",
        organizationId: "org-owner",
      }),
      "project-b": createLocalProject("project-b", {
        name: "Project B",
        organizationId: "org-owner",
      }),
    });
    const { result, dispatch, logger } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-owner",
    });

    await act(async () => {
      result.current.handleProjectShared("convex-project-b", "project-b");
    });

    expect(localStorage.getItem("convex-active-project-id")).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_PROJECT",
      projectId: "project-b",
      updates: { sharedProjectId: "convex-project-b" },
    });
    expect(logger.info).toHaveBeenCalledWith("Project shared", {
      convexProjectId: "convex-project-b",
      sourceProjectId: "project-b",
      switchedActiveProject: false,
    });
  });

  it("uses the active project as the source when legacy share callers omit it", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = {
      ...createAppState({
        "project-a": createLocalProject("project-a", {
          name: "Project A",
          organizationId: "org-owner",
          sharedProjectId: "convex-project-a",
        }),
      }),
      activeProjectId: "project-a",
    };

    const { result, rerender, dispatch } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-owner",
    });

    await act(async () => {
      result.current.handleProjectShared("convex-project-a");
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_PROJECT",
      projectId: "project-a",
      updates: { sharedProjectId: "convex-project-a" },
    });

    projectQueryState.allProjects = [
      {
        _id: "convex-project-a",
        name: "Project A",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-owner",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];

    await act(async () => {
      rerender({
        organizationId: "org-owner",
        hasOrganizationsOverride: true,
        isLoadingOrganizationsOverride: false,
        routeOrganizationIdOverride: undefined,
        validOrganizationIdsOverride: ["org-owner"],
      });
    });

    expect(result.current.useLocalFallback).toBe(false);
    expect(result.current.effectiveActiveProjectId).toBe("convex-project-a");
    expect(result.current.effectiveProjects["project-a"]).toBeUndefined();
    expect(result.current.effectiveProjects["convex-project-a"]).toBeDefined();
  });

  it("v2 client-config saves resolve even if the hook unmounts after the call", async () => {
    // Phase 4: the v2 mutation is awaited and there is no in-flight
    // echo wait that an unmount could interrupt. Once the mutation
    // resolves the save is durable; the hook unmounting later doesn't
    // reject the promise.
    const savedConfig: ProjectConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: {},
        requestTimeout: 10000,
      },
      clientCapabilities: {
        experimental: {
          inspectorProfile: true,
        },
      },
    };

    projectQueryState.allProjects = [
      {
        _id: "remote-1",
        name: "Remote project",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    localStorage.setItem("convex-active-project-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result, unmount } = renderUseProjectState({ appState });

    await result.current.handleUpdateClientConfig("remote-1", savedConfig);

    expect(patchProjectDefaultConnectionMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(useClientConfigStore.getState().isSaving).toBe(false);
  });
});

describe("useProjectState guest active project handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];
    projectQueryState.isLoading = false;
    projectServersState.servers = undefined;
    projectServersState.isLoading = false;
    ensureDefaultProjectMock.mockResolvedValue("guest-project-id");
    organizationBillingStatusState.value = undefined;
    useOrganizationBillingStatusMock.mockImplementation(
      () => organizationBillingStatusState.value,
    );
  });

  it("ignores any pre-existing per-actor stored project id for guests", async () => {
    localStorage.setItem(
      "convex-active-project-id:guest-abc",
      "stale-orphan-project",
    );
    projectQueryState.allProjects = [
      {
        _id: "guest-project",
        name: "Guest Default",
        servers: {},
        ownerId: "guest-user",
        organizationId: undefined as any,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectServersState.servers = [];

    const appState = createAppState({});
    const { result } = renderUseProjectState({
      appState,
      hasOrganizations: false,
      hasSignedInUser: false,
      currentActorKey: "guest-abc",
    });

    await waitFor(() => {
      expect(result.current.effectiveActiveProjectId).toBe("guest-project");
    });

    expect(
      localStorage.getItem("convex-active-project-id:guest-abc"),
    ).toBeNull();
  });

  it("does not persist active project selection for guests", async () => {
    projectQueryState.allProjects = [
      {
        _id: "guest-project",
        name: "Guest Default",
        servers: {},
        ownerId: "guest-user",
        organizationId: undefined as any,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectServersState.servers = [];

    const appState = createAppState({});
    const { result } = renderUseProjectState({
      appState,
      hasOrganizations: false,
      hasSignedInUser: false,
      currentActorKey: "guest-abc",
    });

    await waitFor(() => {
      expect(result.current.effectiveActiveProjectId).toBe("guest-project");
    });

    expect(
      localStorage.getItem("convex-active-project-id:guest-abc"),
    ).toBeNull();
  });

  it("populates servers for guest's active project once flat servers query resolves", async () => {
    projectQueryState.allProjects = [
      {
        _id: "guest-project",
        name: "Guest Default",
        servers: {},
        ownerId: "guest-user",
        organizationId: undefined as any,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectServersState.servers = [
      {
        _id: "server-1",
        projectId: "guest-project",
        name: "excalidraw",
        enabled: true,
        transportType: "http",
        url: "https://mcp.excalidraw.com/",
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const appState = createAppState({});
    const { result } = renderUseProjectState({
      appState,
      hasOrganizations: false,
      hasSignedInUser: false,
      currentActorKey: "guest-abc",
    });

    await waitFor(() => {
      expect(result.current.effectiveActiveProjectId).toBe("guest-project");
    });

    await waitFor(() => {
      const project =
        result.current.effectiveProjects[result.current.effectiveActiveProjectId];
      expect(project?.servers).toBeDefined();
      // The deserializeServersFromConvex mock is a pass-through so the array
      // becomes index-keyed; what matters here is that the merge populated the
      // active project's servers from the flat list rather than leaving {}.
      expect(Object.keys(project?.servers ?? {}).length).toBe(1);
    });
  });
});

describe("useProjectState first-paint server visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];
    projectQueryState.isLoading = false;
    projectServersState.servers = undefined;
    projectServersState.isLoading = false;
    organizationBillingStatusState.value = undefined;
    useOrganizationBillingStatusMock.mockImplementation(
      () => organizationBillingStatusState.value,
    );
  });

  it("renders the active project's flat servers without waiting for the auto-set effect to copy convexActiveProjectId", async () => {
    // Reproduces the cmd+R bug: for a guest, convexActiveProjectId starts at
    // null. The auto-set effect copies remoteProjects[0]._id into it, but
    // useProjectServers must fire for the right id on the *same* frame the
    // user sees, or the project briefly renders as "no servers connected".
    projectQueryState.allProjects = [
      {
        _id: "guest-project",
        name: "Default",
        servers: {},
        ownerId: "guest-user",
        organizationId: undefined as any,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectServersState.servers = [
      {
        _id: "server-1",
        projectId: "guest-project",
        name: "excalidraw",
        enabled: true,
        transportType: "http",
        url: "https://mcp.excalidraw.com/",
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const appState = createAppState({});
    const { result } = renderUseProjectState({
      appState,
      hasOrganizations: false,
      hasSignedInUser: false,
      currentActorKey: "guest-abc",
    });

    // The merge must populate servers from the flat list even before
    // convexActiveProjectId catches up to remoteProjects[0]._id.
    await waitFor(() => {
      const project = result.current.effectiveProjects["guest-project"];
      expect(Object.keys(project?.servers ?? {}).length).toBe(1);
    });
  });
});

describe("useProjectState convexProjects merge under loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];
    projectQueryState.isLoading = false;
    projectServersState.servers = undefined;
    projectServersState.isLoading = false;
    organizationBillingStatusState.value = undefined;
    useOrganizationBillingStatusMock.mockImplementation(
      () => organizationBillingStatusState.value,
    );
  });

  it("does not fall through to embedded servers map for the active project while flat servers load", async () => {
    // Simulate the bug: a guest project doc has servers: {} (vestigial empty
    // map) but the flat servers table is the real source. While the flat
    // query is in flight, the active project must not render an empty list
    // that consumers could mistake for "no servers."
    projectQueryState.allProjects = [
      {
        _id: "guest-project",
        name: "Guest Default",
        servers: {},
        ownerId: "guest-user",
        organizationId: undefined as any,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectServersState.servers = undefined; // loading
    projectServersState.isLoading = true;

    const appState = createAppState({});
    const { result } = renderUseProjectState({
      appState,
      hasOrganizations: false,
      hasSignedInUser: false,
      currentActorKey: "guest-abc",
    });

    await waitFor(() => {
      expect(result.current.effectiveActiveProjectId).toBe("guest-project");
    });

    // While loading, isLoadingRemoteProjects is the contract for "we don't
    // know yet." We just need to make sure the empty embedded map didn't
    // sneak through as authoritative.
    expect(result.current.isLoadingRemoteProjects).toBe(true);
    // The active project's servers are empty (loading), not falsely
    // populated from the embedded rw.servers map.
    expect(
      result.current.effectiveProjects["guest-project"]?.servers,
    ).toEqual({});
  });
});

describe("useProjectState bulk-server query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];
    projectQueryState.isLoading = false;
    projectServersState.servers = undefined;
    projectServersState.isLoading = false;
    projectsBulkServersState.serversByProject = {};
    projectsBulkServersState.isLoading = false;
    emitEmbeddedBlobReadMock.mockReset();
    organizationBillingStatusState.value = undefined;
    useOrganizationBillingStatusMock.mockImplementation(
      () => organizationBillingStatusState.value,
    );
  });

  it("prefers the bulk-query result over the embedded servers blob", async () => {
    projectQueryState.allProjects = [
      {
        _id: "active",
        name: "Active",
        servers: { stale: { name: "stale" } },
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: "non-active",
        name: "Non-Active",
        // The embedded blob has a stale entry that the bulk result should
        // override.
        servers: { stale: { name: "stale" } },
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectsBulkServersState.serversByProject = {
      "non-active": [{ name: "fresh-from-bulk" } as any],
    };
    projectsBulkServersState.isLoading = false;

    const appState = createAppState({});
    const { result } = renderUseProjectState({ appState });

    await waitFor(() => {
      expect(result.current.effectiveProjects["non-active"]).toBeDefined();
    });

    const nonActiveServers =
      result.current.effectiveProjects["non-active"].servers;
    expect(Object.keys(nonActiveServers)).toEqual(["fresh-from-bulk"]);
    expect(nonActiveServers).not.toHaveProperty("stale");
  });

  it("stale-while-revalidate: falls through to the embedded blob until the bulk query resolves", async () => {
    projectQueryState.allProjects = [
      {
        _id: "active",
        name: "Active",
        servers: {},
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: "non-active",
        name: "Non-Active",
        servers: { embedded: { name: "embedded" } },
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    // Bulk query has not resolved yet.
    projectsBulkServersState.serversByProject = {};
    projectsBulkServersState.isLoading = true;

    const appState = createAppState({});
    const { result } = renderUseProjectState({ appState });

    await waitFor(() => {
      expect(result.current.effectiveProjects["non-active"]).toBeDefined();
    });

    // The non-active project renders the embedded blob immediately so the
    // picker never flashes "0 server(s)" before bulk hydration.
    expect(
      Object.keys(result.current.effectiveProjects["non-active"].servers),
    ).toEqual(["embedded"]);
  });

  it("emits embedded-blob-read telemetry when the SWR fallback is used", async () => {
    projectQueryState.allProjects = [
      {
        _id: "active",
        name: "Active",
        servers: {},
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: "fallback-1",
        name: "Fallback 1",
        servers: { a: { name: "a" }, b: { name: "b" } },
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: "fallback-2",
        name: "Fallback 2",
        servers: { c: { name: "c" } },
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectsBulkServersState.serversByProject = {};
    projectsBulkServersState.isLoading = true;

    const appState = createAppState({});
    renderUseProjectState({ appState });

    await waitFor(() => {
      expect(emitEmbeddedBlobReadMock).toHaveBeenCalled();
    });

    const ids = emitEmbeddedBlobReadMock.mock.calls.map(
      (c: any[]) => c[0].projectId,
    );
    expect(ids).toContain("fallback-1");
    expect(ids).toContain("fallback-2");
    // Active project must not emit — its servers don't come from the
    // embedded blob, they come from the flat single-project query.
    expect(ids).not.toContain("active");

    const fallback1Call = emitEmbeddedBlobReadMock.mock.calls.find(
      (c: any[]) => c[0].projectId === "fallback-1",
    );
    expect(fallback1Call?.[0].serverCount).toBe(2);
  });

  it("does not emit telemetry once the bulk query has resolved for a project", async () => {
    // The telemetry path skips the active project unconditionally, so a
    // single-project setup would pass even if the bulk-resolved short-circuit
    // were removed. The `active-spacer` project owns the active slot so `p1`
    // is forced through the non-active path and the bulk-resolved check is
    // what we're actually exercising.
    projectQueryState.allProjects = [
      {
        _id: "active-spacer",
        name: "Active",
        servers: {},
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        _id: "p1",
        name: "P1",
        servers: { embedded: { name: "embedded" } },
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectsBulkServersState.serversByProject = {
      p1: [{ name: "bulk" } as any],
    };
    projectsBulkServersState.isLoading = false;

    const appState = createAppState({
      p1: {
        id: "p1",
        name: "P1",
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    renderUseProjectState({ appState });

    await waitFor(() => {
      expect(emitEmbeddedBlobReadMock).not.toHaveBeenCalled();
    });
  });

  it("does not emit telemetry for the active project even when its embedded blob is non-empty", async () => {
    projectQueryState.allProjects = [
      {
        _id: "active",
        name: "Active",
        // Active project's embedded blob is vestigial — its servers come from
        // the flat single-project query, so even when this map is non-empty
        // we must not count it as a read.
        servers: { vestigial: { name: "vestigial" } },
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectServersState.servers = []; // flat query resolved with no servers
    projectsBulkServersState.serversByProject = {};
    projectsBulkServersState.isLoading = false;

    const appState = createAppState({
      active: {
        id: "active",
        name: "Active",
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    renderUseProjectState({ appState });

    await waitFor(() => {
      expect(emitEmbeddedBlobReadMock).not.toHaveBeenCalled();
    });
  });

  it("exposes bulk-loading state through the hook return", async () => {
    projectQueryState.allProjects = [
      {
        _id: "p1",
        name: "P1",
        servers: {},
        ownerId: "u1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectsBulkServersState.serversByProject = {};
    projectsBulkServersState.isLoading = true;

    const appState = createAppState({});
    const { result } = renderUseProjectState({ appState });

    await waitFor(() => {
      expect(result.current.isLoadingBulkServers).toBe(true);
    });
  });
});

describe("useProjectState cold-share data-loss guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];
    projectQueryState.isLoading = false;
    projectServersState.servers = undefined;
    projectServersState.isLoading = false;
    projectsBulkServersState.serversByProject = {};
    projectsBulkServersState.isLoading = false;
    sentryCaptureMessageMock.mockReset();
    createProjectMock.mockResolvedValue("new-remote-id");
    organizationBillingStatusState.value = { canManageBilling: true };
    useOrganizationBillingStatusMock.mockImplementation(
      () => organizationBillingStatusState.value,
    );
  });

  it("captures a Sentry message when handleDuplicateProject sends empty servers but the bulk query has servers for the source", async () => {
    // The first remote project is treated as the active project by the hook
    // when no explicit selection exists; its servers route through the flat
    // single-project query rather than through the bulk query. The spacer
    // claims that slot so `remote-1` exercises the bulk-query path under
    // test.
    projectQueryState.allProjects = [
      {
        _id: "active-spacer",
        name: "Active",
        servers: {},
        ownerId: "u1",
        organizationId: "org-route",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        _id: "remote-1",
        name: "Source Project",
        servers: {}, // empty in-record copy — before the bulk-query swap the picker had a stale read
        ownerId: "u1",
        organizationId: "org-route",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    // The bulk query KNOWS the source has servers — but the user clicked
    // duplicate before the bulk hydration propagated into the project
    // state. Without the guard, this would silently create an empty
    // duplicate.
    projectsBulkServersState.serversByProject = {
      "remote-1": [{ name: "s1" } as any, { name: "s2" } as any],
    };

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-route",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-route"],
    });

    // Simulate the cold-duplicate race: when handleDuplicateProject reads
    // sourceProject.servers, the bulk-fed version hasn't been threaded into
    // effectiveProjects yet (this mirrors a window of a few render frames
    // in production). The serializer mock is identity, so an empty source
    // map → empty serialized payload.
    serializeServersForSharingMock.mockImplementationOnce(() => ({}));

    await act(async () => {
      await result.current.handleDuplicateProject("remote-1", "Copy");
    });

    expect(sentryCaptureMessageMock).toHaveBeenCalledTimes(1);
    const [message, options] = sentryCaptureMessageMock.mock.calls[0];
    expect(message).toMatch(/Cold-share data-loss invariant tripped/);
    expect(options.level).toBe("error");
    expect(options.extra.callSite).toBe("duplicate");
    expect(options.extra.sourceProjectId).toBe("remote-1");
    expect(options.extra.serializedServerCount).toBe(0);
    expect(options.extra.bulkServerCount).toBe(2);
  });

  it("does not fire when the serialized payload is non-empty", async () => {
    // Two projects: an active one (its servers come from the flat query, not
    // the bulk query) and a non-active duplicate target (the one we
    // exercise). Without the spacer the picker treats the first remote
    // project as active and routes its server count through the empty flat
    // query instead of through the bulk-query path we want to test.
    projectQueryState.allProjects = [
      {
        _id: "active-spacer",
        name: "Active",
        servers: {},
        ownerId: "u1",
        organizationId: "org-route",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        _id: "remote-2",
        name: "Source Project",
        servers: { good: { name: "good" } },
        ownerId: "u1",
        organizationId: "org-route",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    projectsBulkServersState.serversByProject = {
      "remote-2": [{ name: "good" } as any],
    };

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-route",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-route"],
    });

    await act(async () => {
      await result.current.handleDuplicateProject("remote-2", "Copy");
    });

    expect(sentryCaptureMessageMock).not.toHaveBeenCalled();
    expect(createProjectMock).toHaveBeenCalled();
  });

  it("does not fire when the source project legitimately has no servers", async () => {
    projectQueryState.allProjects = [
      {
        _id: "active-spacer",
        name: "Active",
        servers: {},
        ownerId: "u1",
        organizationId: "org-route",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        _id: "remote-3",
        name: "Empty Project",
        servers: {},
        ownerId: "u1",
        organizationId: "org-route",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    projectQueryState.projects = projectQueryState.allProjects;
    // Bulk query confirmed the source is genuinely empty.
    projectsBulkServersState.serversByProject = {
      "remote-3": [],
    };

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-route",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-route"],
    });

    serializeServersForSharingMock.mockImplementationOnce(() => ({}));

    await act(async () => {
      await result.current.handleDuplicateProject("remote-3", "Copy");
    });

    expect(sentryCaptureMessageMock).not.toHaveBeenCalled();
    expect(createProjectMock).toHaveBeenCalled();
  });

  it("captures the import call site with a null bulkServerCount", async () => {
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-route",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-route"],
    });

    serializeServersForSharingMock.mockImplementationOnce(() => ({}));

    await act(async () => {
      await result.current.handleImportProject({
        id: "import-1",
        name: "Imported",
        // The user pasted a file that claims the project has servers, but
        // the post-serialize shape came out empty. This is the only
        // realistic way the assertion fires on the import path.
        servers: { ghost: { name: "ghost" } as any },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
    });

    expect(sentryCaptureMessageMock).toHaveBeenCalledTimes(1);
    const [, options] = sentryCaptureMessageMock.mock.calls[0];
    expect(options.extra.callSite).toBe("import");
    expect(options.extra.bulkServerCount).toBeNull();
    expect(options.extra.embeddedServerCount).toBe(1);
  });

  it("captures the migrate call site when local-project migration serializes to empty", async () => {
    // Local-only project with servers, ready to be migrated to Convex.
    // The migration effect auto-fires on mount when an authenticated user
    // has a matching organization and a local project that needs sharing.
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];

    const appState = createAppState({
      default: createSyntheticDefaultProject(),
      "local-1": createLocalProject("local-1", {
        name: "Local with servers",
        organizationId: "org-migrate",
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    // Force the serializer to drop every server. This is the only realistic
    // way to trip the assertion on the migrate path — a real bug in the
    // serialize step (or a future regression that nukes the map) would
    // look exactly like this from the caller's perspective.
    serializeServersForSharingMock.mockImplementationOnce(() => ({}));

    renderUseProjectState({
      appState,
      activeOrganizationId: "org-migrate",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-migrate"],
    });

    await waitFor(() => {
      expect(sentryCaptureMessageMock).toHaveBeenCalled();
    });

    const migrateCall = sentryCaptureMessageMock.mock.calls.find(
      (c: any[]) => c[1]?.extra?.callSite === "migrate",
    );
    expect(migrateCall, "expected a migrate-callSite Sentry message").toBeDefined();
    expect(migrateCall![1].extra.serializedServerCount).toBe(0);
    // local-only project ids never appear in the bulk-query map, so
    // bulkServerCount is null for the migrate path by construction.
    expect(migrateCall![1].extra.bulkServerCount).toBeNull();
    expect(migrateCall![1].extra.embeddedServerCount).toBe(1);
    expect(migrateCall![1].extra.sourceProjectId).toBe("local-1");
  });
});
