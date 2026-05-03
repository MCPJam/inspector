import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { AppAction, AppState, Project } from "@/state/app-types";
import { useProjectState } from "../use-project-state";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/host-context-store";
import type {
  ProjectClientConfig,
  ProjectConnectionConfigDraft,
  ProjectHostContextDraft,
} from "@/lib/client-config";

const {
  createProjectMock,
  ensureDefaultProjectMock,
  updateClientConfigMock,
  updateProjectMock,
  deleteProjectMock,
  projectQueryState,
  organizationBillingStatusState,
  useOrganizationBillingStatusMock,
  serializeServersForSharingMock,
} = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  ensureDefaultProjectMock: vi.fn(),
  updateClientConfigMock: vi.fn(),
  updateProjectMock: vi.fn(),
  deleteProjectMock: vi.fn(),
  projectQueryState: {
    allProjects: undefined as any,
    projects: undefined as any,
    isLoading: false,
  },
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
    updateClientConfig: updateClientConfigMock,
    deleteProject: deleteProjectMock,
  }),
  useProjectServers: () => ({
    servers: undefined,
    isLoading: false,
  }),
}));

vi.mock("../useOrganizationBilling", () => ({
  useOrganizationBillingStatus: (...args: unknown[]) =>
    useOrganizationBillingStatusMock(...args),
}));

vi.mock("@/lib/project-serialization", () => ({
  deserializeServersFromConvex: vi.fn((servers) => servers ?? {}),
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
  hasOrganizations = true,
  isLoadingOrganizations = false,
  validOrganizationIds,
}: {
  appState: AppState;
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  isAuthenticated?: boolean;
  hasOrganizations?: boolean;
  isLoadingOrganizations?: boolean;
  validOrganizationIds?: string[];
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
        currentActorKey: "test-actor",
        hasSignedInUser: true,
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
    updateClientConfigMock.mockResolvedValue(undefined);
    updateProjectMock.mockResolvedValue("remote-project-id");
    deleteProjectMock.mockResolvedValue(undefined);
    projectQueryState.allProjects = [];
    projectQueryState.projects = [];
    projectQueryState.isLoading = false;
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

  it("keeps authenticated client-config saves pending until the remote echo arrives", async () => {
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
    const expectedPersistedClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: {
        headers: {},
        requestTimeout: 10000,
      },
      clientCapabilities: savedConfig.clientCapabilities,
      hostContext: {},
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
    const { result, rerender } = renderUseProjectState({ appState });

    let resolved = false;
    const savePromise = result.current
      .handleUpdateClientConfig("remote-1", savedConfig)
      .then(() => {
        resolved = true;
      });

    await waitFor(() => {
      expect(updateClientConfigMock).toHaveBeenCalledWith({
        projectId: "remote-1",
        clientConfig: expectedPersistedClientConfig,
      });
    });

    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(true);
    expect(resolved).toBe(false);

    projectQueryState.allProjects = [
      {
        ...projectQueryState.allProjects[0],
        clientConfig: expectedPersistedClientConfig,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    rerender({ organizationId: undefined });

    await waitFor(() => {
      expect(resolved).toBe(true);
    });

    await savePromise;
  });

  it("composes host-context saves with the target project connection config", async () => {
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
    const { result, rerender } = renderUseProjectState({ appState });

    const savePromise = result.current.handleUpdateHostContext(
      "remote-2",
      savedHostContext,
    );

    await waitFor(() => {
      expect(updateClientConfigMock).toHaveBeenCalledWith({
        projectId: "remote-2",
        clientConfig: expectedPersistedClientConfig,
      });
    });

    projectQueryState.allProjects = [
      projectQueryState.allProjects[0],
      {
        ...projectQueryState.allProjects[1],
        clientConfig: expectedPersistedClientConfig,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    rerender({ organizationId: undefined });

    await savePromise;
  });

  it("composes connection-config saves with the target project host context", async () => {
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
    const { result, rerender } = renderUseProjectState({ appState });

    const savePromise = result.current.handleUpdateClientConfig(
      "remote-2",
      savedConnectionConfig,
    );

    await waitFor(() => {
      expect(updateClientConfigMock).toHaveBeenCalledWith({
        projectId: "remote-2",
        clientConfig: expectedPersistedClientConfig,
      });
    });

    projectQueryState.allProjects = [
      projectQueryState.allProjects[0],
      {
        ...projectQueryState.allProjects[1],
        clientConfig: expectedPersistedClientConfig,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    rerender({ organizationId: undefined });

    await savePromise;
  });

  it("keeps a newer project save pending when an older save times out", async () => {
    vi.useFakeTimers();

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
    const secondPersistedClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: secondSavedConfig.connectionDefaults,
      clientCapabilities: secondSavedConfig.clientCapabilities,
      hostContext: {},
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
    const { result, rerender } = renderUseProjectState({ appState });

    const firstSavePromise = result.current.handleUpdateClientConfig(
      "remote-1",
      firstSavedConfig,
    );
    const firstSaveError = firstSavePromise.catch((error) => error);

    await Promise.resolve();
    expect(updateClientConfigMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    const secondSavePromise = result.current.handleUpdateClientConfig(
      "remote-2",
      secondSavedConfig,
    );

    await Promise.resolve();
    expect(updateClientConfigMock).toHaveBeenCalledTimes(2);
    expect(useClientConfigStore.getState().pendingProjectId).toBe("remote-2");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    await expect(firstSaveError).resolves.toBeInstanceOf(Error);
    await expect(firstSavePromise).rejects.toThrow(
      "Timed out waiting for project client config to sync.",
    );
    expect(useClientConfigStore.getState().pendingProjectId).toBe("remote-2");
    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(true);

    projectQueryState.allProjects = [
      projectQueryState.allProjects[0],
      {
        ...projectQueryState.allProjects[1],
        clientConfig: secondPersistedClientConfig,
      },
    ];
    projectQueryState.projects = [...projectQueryState.allProjects];
    rerender({ organizationId: undefined });

    await secondSavePromise;
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

  it("keeps zero-org recovery empty even after local fallback activated while org loading was still pending", async () => {
    vi.useFakeTimers();
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
    projectQueryState.projects = undefined;
    localStorage.setItem("convex-active-project-id", "remote-1");

    const appState = createAppState({
      "local-1": createLocalProject("local-1", {
        organizationId: "org-live",
      }),
    });
    const { result, rerender } = renderUseProjectState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: false,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveProjects).toEqual(appState.projects);

    rerender({
      organizationId: undefined,
      hasOrganizationsOverride: false,
      isLoadingOrganizationsOverride: false,
      routeOrganizationIdOverride: undefined,
      validOrganizationIdsOverride: [],
    });

    expect(result.current.effectiveProjects).toEqual({});
    expect(result.current.effectiveActiveProjectId).toBe("none");

    await act(async () => {});
    expect(localStorage.getItem("convex-active-project-id")).toBeNull();
    expect(ensureDefaultProjectMock).not.toHaveBeenCalled();
  });

  it("still uses local fallback when a valid org exists and cloud sync times out", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = createAppState({
      "local-1": createLocalProject("local-1", {
        organizationId: "org-live",
      }),
    });
    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-live",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-live"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveProjects).toEqual(appState.projects);
    expect(result.current.effectiveActiveProjectId).toBe(
      appState.activeProjectId,
    );
  });

  it("scopes local fallback projects to the current org and ignores an active project from another org", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = {
      ...createAppState({
        "local-org-a": createLocalProject("local-org-a", {
          organizationId: "org-a",
        }),
        "local-org-b": createLocalProject("local-org-b", {
          organizationId: "org-b",
        }),
      }),
      activeProjectId: "local-org-b",
    };

    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveProjects).toEqual({
      "local-org-a": appState.projects["local-org-a"],
    });
    expect(result.current.effectiveActiveProjectId).toBe("local-org-a");
  });

  it("hides unscoped and wrong-org local fallback projects when the current org has no local matches", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = createAppState({
      "local-unscoped": createLocalProject("local-unscoped"),
      "local-org-b": createLocalProject("local-org-b", {
        organizationId: "org-b",
      }),
    });

    const { result } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveProjects).toEqual({});
    expect(result.current.effectiveActiveProjectId).toBe("none");
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

  it("stamps the current org id on local fallback create, duplicate, and import actions", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = createAppState({
      "local-org-a": createLocalProject("local-org-a", {
        name: "Project A",
        organizationId: "org-a",
      }),
    });

    const { result, dispatch } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    await act(async () => {
      await result.current.handleCreateProject("Created locally");
    });

    expect(createProjectMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "CREATE_PROJECT",
      project: expect.objectContaining({
        name: "Created locally",
        organizationId: "org-a",
      }),
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleDuplicateProject(
        "local-org-a",
        "Duplicated locally",
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "CREATE_PROJECT",
      project: expect.objectContaining({
        name: "Duplicated locally",
        organizationId: "org-a",
      }),
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleImportProject(
        createLocalProject("import-me", {
          name: "Imported locally",
        }),
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "IMPORT_PROJECT",
      project: expect.objectContaining({
        name: "Imported locally",
        organizationId: "org-a",
      }),
    });
  });

  it("updates projects locally in authenticated fallback mode", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = createAppState({
      "local-org-a": createLocalProject("local-org-a", {
        name: "Project A",
        organizationId: "org-a",
      }),
    });

    const { result, dispatch } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleUpdateProject("local-org-a", {
        name: "Project A Renamed",
      });
    });

    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_PROJECT",
      projectId: "local-org-a",
      updates: {
        name: "Project A Renamed",
      },
    });
  });

  it("deletes active projects locally in authenticated fallback mode", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = {
      ...createAppState({
        "local-org-a-1": createLocalProject("local-org-a-1", {
          name: "Project A1",
          organizationId: "org-a",
        }),
        "local-org-a-2": createLocalProject("local-org-a-2", {
          name: "Project A2",
          organizationId: "org-a",
        }),
      }),
      activeProjectId: "local-org-a-1",
    };

    const { result, dispatch } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleDeleteProject("local-org-a-1");
    });

    expect(deleteProjectMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: "SWITCH_PROJECT",
      projectId: "local-org-a-2",
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "DELETE_PROJECT",
      projectId: "local-org-a-1",
    });
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

  it("fails authenticated client-config saves when the remote echo times out", async () => {
    vi.useFakeTimers();

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

    const savePromise = result.current.handleUpdateClientConfig(
      "remote-1",
      savedConfig,
    );
    const saveError = savePromise.catch((error) => error);

    await Promise.resolve();
    expect(updateClientConfigMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await expect(saveError).resolves.toBeInstanceOf(Error);
    await expect(savePromise).rejects.toThrow(
      "Timed out waiting for project client config to sync.",
    );
    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(false);
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

  it("keeps a non-shared active local project selected after remote projects return", async () => {
    vi.useFakeTimers();
    projectQueryState.allProjects = undefined;
    projectQueryState.projects = undefined;

    const appState = {
      ...createAppState({
        "project-a": createLocalProject("project-a", {
          name: "Project A",
          organizationId: "org-owner",
        }),
        "project-b": createLocalProject("project-b", {
          name: "Project B",
          organizationId: "org-owner",
          sharedProjectId: "convex-project-b",
        }),
      }),
      activeProjectId: "project-a",
    };

    const { result, rerender } = renderUseProjectState({
      appState,
      activeOrganizationId: "org-owner",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.useLocalFallback).toBe(true);

    projectQueryState.allProjects = [
      {
        _id: "convex-project-b",
        name: "Project B",
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
    expect(result.current.effectiveActiveProjectId).toBe("project-a");
    expect(result.current.effectiveProjects["project-a"]).toBeDefined();
    expect(result.current.effectiveProjects["convex-project-b"]).toBeDefined();
    expect(result.current.effectiveProjects["project-b"]).toBeUndefined();
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

  it("rejects authenticated client-config saves when the hook unmounts mid-sync", async () => {
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
    const expectedPersistedClientConfig: ProjectClientConfig = {
      version: 1,
      connectionDefaults: {
        headers: {},
        requestTimeout: 10000,
      },
      clientCapabilities: savedConfig.clientCapabilities,
      hostContext: {},
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

    const savePromise = result.current.handleUpdateClientConfig(
      "remote-1",
      savedConfig,
    );

    await waitFor(() => {
      expect(updateClientConfigMock).toHaveBeenCalledWith({
        projectId: "remote-1",
        clientConfig: expectedPersistedClientConfig,
      });
    });

    unmount();

    await expect(savePromise).rejects.toThrow(
      "Project client config sync was interrupted.",
    );
    await waitFor(() => {
      expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(false);
      expect(useClientConfigStore.getState().isSaving).toBe(false);
    });
  });
});
