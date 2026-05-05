/**
 * Mock stores for testing components that depend on Zustand or other state management.
 * These mocks provide controlled state for predictable testing.
 */
import { vi } from "vitest";
import type { AppState, ServerWithName, Project } from "@/state/app-types";
import type {
  HostDisplayMode,
  ProjectConnectionConfigDraft,
  ProjectClientConfig,
  ProjectHostContextDraft,
} from "@/lib/client-config";
import { createServer, createProject } from "../factories";

/**
 * Creates a minimal valid AppState for testing
 */
export function createMockAppState(
  overrides: Partial<AppState> = {},
): AppState {
  const defaultProject = createProject({
    id: "default-project",
    isDefault: true,
  });

  return {
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
    projects: { [defaultProject.id]: defaultProject },
    activeProjectId: defaultProject.id,
    ...overrides,
  };
}

/**
 * Creates mock AppState with servers
 */
export function createMockAppStateWithServers(
  servers: ServerWithName[],
  overrides: Partial<AppState> = {},
): AppState {
  const serversMap = Object.fromEntries(servers.map((s) => [s.name, s]));
  const project = createProject({
    id: "default-project",
    isDefault: true,
    servers: serversMap,
  });

  return createMockAppState({
    servers: serversMap,
    projects: { [project.id]: project },
    activeProjectId: project.id,
    ...overrides,
  });
}

/**
 * Creates a mock for the useAppState hook return value
 */
export function createMockUseAppState(
  overrides: Partial<ReturnType<any>> = {},
) {
  const appState = createMockAppState();
  const defaultProject = Object.values(appState.projects)[0];

  return {
    // State
    appState,
    isLoading: false,
    isLoadingRemoteProjects: false,
    isCloudSyncActive: false,

    // Computed values
    projectServers: appState.servers,
    connectedOrConnectingServerConfigs: {},
    selectedServerEntry: undefined,
    selectedMCPConfig: undefined,
    selectedMCPConfigs: [],
    selectedMCPConfigsMap: {},
    isMultiSelectMode: false,

    // Project-related
    projects: appState.projects,
    activeProjectId: appState.activeProjectId,
    activeProject: defaultProject,

    // Actions (all mocked)
    handleConnect: vi.fn().mockResolvedValue(undefined),
    handleDisconnect: vi.fn().mockResolvedValue(undefined),
    handleReconnect: vi.fn().mockResolvedValue(undefined),
    handleUpdate: vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    }),
    handleRemoveServer: vi.fn().mockResolvedValue(undefined),
    setSelectedServer: vi.fn(),
    setSelectedMCPConfigs: vi.fn(),
    toggleMultiSelectMode: vi.fn(),
    toggleServerSelection: vi.fn(),
    getValidAccessToken: vi.fn().mockResolvedValue(null),
    setSelectedMultipleServersToAllServers: vi.fn(),
    saveServerConfigWithoutConnecting: vi.fn().mockResolvedValue(undefined),
    handleConnectWithTokensFromOAuthFlow: vi.fn().mockResolvedValue(undefined),
    handleRefreshTokensFromOAuthFlow: vi.fn().mockResolvedValue(undefined),

    // Project actions
    handleSwitchProject: vi.fn().mockResolvedValue(undefined),
    handleCreateProject: vi.fn().mockResolvedValue("new-project-id"),
    handleUpdateProject: vi.fn().mockResolvedValue(undefined),
    handleDeleteProject: vi.fn().mockResolvedValue(undefined),
    handleLeaveProject: vi.fn().mockResolvedValue(undefined),
    handleDuplicateProject: vi.fn().mockResolvedValue(undefined),
    handleSetDefaultProject: vi.fn(),
    handleProjectShared: vi.fn(),
    handleExportProject: vi.fn(),
    handleImportProject: vi.fn().mockResolvedValue(undefined),

    ...overrides,
  };
}

/**
 * Creates mock for Convex auth hook
 */
export function createMockConvexAuth(overrides = {}) {
  return {
    isAuthenticated: false,
    isLoading: false,
    ...overrides,
  };
}

/**
 * Creates mock for project queries hook
 */
export function createMockProjectQueries(
  projects: Project[] = [],
  overrides = {},
) {
  return {
    projects,
    isLoading: false,
    ...overrides,
  };
}

/**
 * Creates mock for project mutations hook
 */
export function createMockProjectMutations(overrides = {}) {
  return {
    createProject: vi.fn().mockResolvedValue("new-project-id"),
    updateProject: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export type MockClientConfigStoreState = {
  activeProjectId: string | null;
  defaultConfig: ProjectConnectionConfigDraft | null;
  savedConfig: ProjectConnectionConfigDraft | undefined;
  draftConfig: ProjectConnectionConfigDraft | null;
  connectionDefaultsText: string;
  clientCapabilitiesText: string;
  connectionDefaultsError: string | null;
  clientCapabilitiesError: string | null;
  isSaving: boolean;
  isDirty: boolean;
};

export type MockHostContextStoreState = {
  activeProjectId: string | null;
  defaultHostContext: ProjectHostContextDraft;
  savedHostContext: ProjectHostContextDraft | undefined;
  draftHostContext: ProjectHostContextDraft;
  hostContextText: string;
  hostContextError: string | null;
  isSaving: boolean;
  isDirty: boolean;
};

function stringifyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function createMockProjectClientConfig(
  overrides: Partial<ProjectClientConfig> = {},
): ProjectClientConfig {
  return {
    version: 1,
    connectionDefaults:
      overrides.connectionDefaults ?? { headers: {}, requestTimeout: 10000 },
    clientCapabilities: overrides.clientCapabilities ?? {},
    hostContext: overrides.hostContext ?? {},
  };
}

export function createMockProjectConnectionConfig(
  overrides: Partial<ProjectConnectionConfigDraft> = {},
): ProjectConnectionConfigDraft {
  return {
    version: 1,
    connectionDefaults:
      overrides.connectionDefaults ?? { headers: {}, requestTimeout: 10000 },
    clientCapabilities: overrides.clientCapabilities ?? {},
  };
}

export function createMockClientConfigStoreState(
  overrides: Partial<MockClientConfigStoreState> = {},
): MockClientConfigStoreState {
  const draftConfig =
    overrides.draftConfig === undefined ? null : overrides.draftConfig;

  return {
    activeProjectId: null,
    defaultConfig: null,
    savedConfig: undefined,
    draftConfig,
    connectionDefaultsText: stringifyJson(
      draftConfig?.connectionDefaults ?? { headers: {}, requestTimeout: 10000 },
    ),
    clientCapabilitiesText: stringifyJson(
      draftConfig?.clientCapabilities ?? {},
    ),
    connectionDefaultsError: null,
    clientCapabilitiesError: null,
    isSaving: false,
    isDirty: false,
    ...overrides,
  };
}

export function createMockHostContextStoreState(
  overrides: Partial<MockHostContextStoreState> = {},
): MockHostContextStoreState {
  const draftHostContext =
    overrides.draftHostContext === undefined ? {} : overrides.draftHostContext;

  return {
    activeProjectId: null,
    defaultHostContext: {},
    savedHostContext: undefined,
    draftHostContext,
    hostContextText: stringifyJson(draftHostContext),
    hostContextError: null,
    isSaving: false,
    isDirty: false,
    ...overrides,
  };
}

/**
 * Presets for common testing scenarios
 */
export const storePresets = {
  /** Empty state - no servers, no connections */
  empty: () => createMockUseAppState(),

  /** Single connected server */
  singleConnected: (serverName = "test-server") => {
    const server = createServer({
      name: serverName,
      connectionStatus: "connected",
      enabled: true,
    });
    const servers = { [server.name]: server };
    const project = createProject({
      id: "default-project",
      isDefault: true,
      servers,
    });

    return createMockUseAppState({
      appState: createMockAppStateWithServers([server]),
      projectServers: servers,
      connectedOrConnectingServerConfigs: servers,
      selectedServer: server.name,
      selectedServerEntry: server,
      selectedMCPConfig: server.config,
      activeProject: project,
    });
  },

  /** Multiple servers, some connected */
  multipleServers: (count = 3, connectedCount = 1) => {
    const servers: ServerWithName[] = [];
    for (let i = 0; i < count; i++) {
      servers.push(
        createServer({
          name: `server-${i + 1}`,
          connectionStatus: i < connectedCount ? "connected" : "disconnected",
          enabled: i < connectedCount,
        }),
      );
    }
    const serversMap = Object.fromEntries(servers.map((s) => [s.name, s]));
    const connectedMap = Object.fromEntries(
      servers
        .filter((s) => s.connectionStatus === "connected")
        .map((s) => [s.name, s]),
    );
    const project = createProject({
      id: "default-project",
      isDefault: true,
      servers: serversMap,
    });

    return createMockUseAppState({
      appState: createMockAppStateWithServers(servers),
      projectServers: serversMap,
      connectedOrConnectingServerConfigs: connectedMap,
      activeProject: project,
    });
  },

  /** Loading state */
  loading: () =>
    createMockUseAppState({
      isLoading: true,
    }),

  /** Authenticated with cloud sync */
  authenticated: () =>
    createMockUseAppState({
      isCloudSyncActive: true,
    }),

  /** Empty client config store state */
  clientConfig: (overrides: Partial<MockClientConfigStoreState> = {}) =>
    createMockClientConfigStoreState(overrides),

  /** Host context with specific host-advertised display modes */
  hostContextWithDisplayModes: (
    availableDisplayModes: HostDisplayMode[],
    overrides: Partial<MockHostContextStoreState> = {},
  ) =>
    createMockHostContextStoreState({
      draftHostContext: { availableDisplayModes },
      ...overrides,
    }),
};
