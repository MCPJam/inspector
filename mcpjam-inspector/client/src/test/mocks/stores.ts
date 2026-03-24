/**
 * Mock stores for testing components that depend on Zustand or other state management.
 * These mocks provide controlled state for predictable testing.
 */
import { vi } from "vitest";
import type { AppState, ServerWithName, Workspace } from "@/state/app-types";
import type {
  HostDisplayMode,
  WorkspaceClientConfig,
} from "@/lib/client-config";
import { createServer, createWorkspace } from "../factories";

/**
 * Creates a minimal valid AppState for testing
 */
export function createMockAppState(
  overrides: Partial<AppState> = {},
): AppState {
  const defaultWorkspace = createWorkspace({
    id: "default-workspace",
    isDefault: true,
  });

  return {
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
    workspaces: { [defaultWorkspace.id]: defaultWorkspace },
    activeWorkspaceId: defaultWorkspace.id,
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
  const workspace = createWorkspace({
    id: "default-workspace",
    isDefault: true,
    servers: serversMap,
  });

  return createMockAppState({
    servers: serversMap,
    workspaces: { [workspace.id]: workspace },
    activeWorkspaceId: workspace.id,
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
  const defaultWorkspace = Object.values(appState.workspaces)[0];

  return {
    // State
    appState,
    isLoading: false,
    isLoadingRemoteWorkspaces: false,
    isCloudSyncActive: false,

    // Computed values
    workspaceServers: appState.servers,
    connectedOrConnectingServerConfigs: {},
    selectedServerEntry: undefined,
    selectedMCPConfig: undefined,
    selectedMCPConfigs: [],
    selectedMCPConfigsMap: {},
    isMultiSelectMode: false,

    // Workspace-related
    workspaces: appState.workspaces,
    activeWorkspaceId: appState.activeWorkspaceId,
    activeWorkspace: defaultWorkspace,

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

    // Workspace actions
    handleSwitchWorkspace: vi.fn().mockResolvedValue(undefined),
    handleCreateWorkspace: vi.fn().mockResolvedValue("new-workspace-id"),
    handleUpdateWorkspace: vi.fn().mockResolvedValue(undefined),
    handleDeleteWorkspace: vi.fn().mockResolvedValue(undefined),
    handleLeaveWorkspace: vi.fn().mockResolvedValue(undefined),
    handleDuplicateWorkspace: vi.fn().mockResolvedValue(undefined),
    handleSetDefaultWorkspace: vi.fn(),
    handleWorkspaceShared: vi.fn(),
    handleExportWorkspace: vi.fn(),
    handleImportWorkspace: vi.fn().mockResolvedValue(undefined),

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
 * Creates mock for workspace queries hook
 */
export function createMockWorkspaceQueries(
  workspaces: Workspace[] = [],
  overrides = {},
) {
  return {
    workspaces,
    isLoading: false,
    ...overrides,
  };
}

/**
 * Creates mock for workspace mutations hook
 */
export function createMockWorkspaceMutations(overrides = {}) {
  return {
    createWorkspace: vi.fn().mockResolvedValue("new-workspace-id"),
    updateWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export type MockClientConfigStoreState = {
  activeWorkspaceId: string | null;
  defaultConfig: WorkspaceClientConfig | null;
  savedConfig: WorkspaceClientConfig | undefined;
  draftConfig: WorkspaceClientConfig | null;
  clientCapabilitiesText: string;
  hostContextText: string;
  clientCapabilitiesError: string | null;
  hostContextError: string | null;
  isSaving: boolean;
  isDirty: boolean;
};

function stringifyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function createMockWorkspaceClientConfig(
  overrides: Partial<WorkspaceClientConfig> = {},
): WorkspaceClientConfig {
  return {
    version: 1,
    clientCapabilities: overrides.clientCapabilities ?? {},
    hostContext: overrides.hostContext ?? {},
  };
}

export function createMockClientConfigStoreState(
  overrides: Partial<MockClientConfigStoreState> = {},
): MockClientConfigStoreState {
  const draftConfig =
    overrides.draftConfig === undefined ? null : overrides.draftConfig;

  return {
    activeWorkspaceId: null,
    defaultConfig: null,
    savedConfig: undefined,
    draftConfig,
    clientCapabilitiesText: stringifyJson(draftConfig?.clientCapabilities ?? {}),
    hostContextText: stringifyJson(draftConfig?.hostContext ?? {}),
    clientCapabilitiesError: null,
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
    const workspace = createWorkspace({
      id: "default-workspace",
      isDefault: true,
      servers,
    });

    return createMockUseAppState({
      appState: createMockAppStateWithServers([server]),
      workspaceServers: servers,
      connectedOrConnectingServerConfigs: servers,
      selectedServer: server.name,
      selectedServerEntry: server,
      selectedMCPConfig: server.config,
      activeWorkspace: workspace,
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
    const workspace = createWorkspace({
      id: "default-workspace",
      isDefault: true,
      servers: serversMap,
    });

    return createMockUseAppState({
      appState: createMockAppStateWithServers(servers),
      workspaceServers: serversMap,
      connectedOrConnectingServerConfigs: connectedMap,
      activeWorkspace: workspace,
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

  /** Client config with specific host-advertised display modes */
  clientConfigWithHostDisplayModes: (
    availableDisplayModes: HostDisplayMode[],
    overrides: Partial<MockClientConfigStoreState> = {},
  ) =>
    createMockClientConfigStoreState({
      draftConfig: createMockWorkspaceClientConfig({
        hostContext: { availableDisplayModes },
      }),
      ...overrides,
    }),
};
