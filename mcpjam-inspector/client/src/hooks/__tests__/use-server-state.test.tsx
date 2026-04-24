import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AppAction } from "@/state/app-types";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
import type { WorkspaceClientConfig } from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useServerState } from "../use-server-state";

const {
  toastError,
  toastSuccess,
  completeHostedOAuthCallbackMock,
  handleOAuthCallbackMock,
  initiateOAuthMock,
  getStoredTokensMock,
  clearOAuthDataMock,
  readStoredOAuthConfigMock,
  testConnectionMock,
  mockConvexQuery,
} = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  completeHostedOAuthCallbackMock: vi.fn(),
  handleOAuthCallbackMock: vi.fn(),
  initiateOAuthMock: vi.fn(),
  getStoredTokensMock: vi.fn(),
  clearOAuthDataMock: vi.fn(),
  readStoredOAuthConfigMock: vi.fn(),
  testConnectionMock: vi.fn(),
  mockConvexQuery: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: mockConvexQuery,
  }),
}));

vi.mock("@/state/mcp-api", () => ({
  testConnection: testConnectionMock,
  deleteServer: vi.fn(),
  listServers: vi.fn(),
  reconnectServer: vi.fn(),
  getInitializationInfo: vi.fn(),
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  completeHostedOAuthCallback: completeHostedOAuthCallbackMock,
  handleOAuthCallback: handleOAuthCallbackMock,
  getStoredTokens: getStoredTokensMock,
  clearOAuthData: clearOAuthDataMock,
  initiateOAuth: initiateOAuthMock,
  readStoredOAuthConfig: readStoredOAuthConfigMock,
}));

vi.mock("@/lib/apis/web/context", () => ({
  injectHostedServerMapping: vi.fn(),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(async () => ({
    json: async () => ({}),
  })),
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: {
    getState: vi.fn(() => ({
      setSelectedToolResult: vi.fn(),
    })),
  },
}));

vi.mock("../useWorkspaces", () => ({
  useServerMutations: () => ({
    createServer: vi.fn(),
    updateServer: vi.fn(),
    deleteServer: vi.fn(),
  }),
}));

function createAppState(options?: {
  workspaceClientConfig?: WorkspaceClientConfig;
  serverCapabilities?: Record<string, unknown>;
}): AppState {
  return {
    workspaces: {
      default: {
        id: "default",
        name: "Default",
        clientConfig: options?.workspaceClientConfig,
        servers: {
          "demo-server": {
            name: "demo-server",
            config: {
              type: "http",
              url: "https://example.com/mcp",
              capabilities: options?.serverCapabilities,
            } as any,
            lastConnectionTime: new Date(),
            connectionStatus: "connecting",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: true,
      },
    },
    activeWorkspaceId: "default",
    servers: {
      "demo-server": {
        name: "demo-server",
        config: {
          type: "http",
          url: "https://example.com/mcp",
          capabilities: options?.serverCapabilities,
        } as any,
        lastConnectionTime: new Date(),
        connectionStatus: "connecting",
        retryCount: 0,
        enabled: true,
        useOAuth: true,
      },
    },
    selectedServer: "demo-server",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

function renderUseServerState(
  dispatch: (action: AppAction) => void,
  appState = createAppState(),
  options?: {
    isAuthenticated?: boolean;
    useLocalFallback?: boolean;
    effectiveWorkspaces?: AppState["workspaces"];
    effectiveActiveWorkspaceId?: string;
    activeWorkspaceServersFlat?: any;
  },
) {
  return renderHook(() =>
    useServerState({
      appState,
      dispatch,
      isLoading: false,
      isAuthenticated: options?.isAuthenticated ?? false,
      isAuthLoading: false,
      isLoadingWorkspaces: false,
      useLocalFallback: options?.useLocalFallback ?? true,
      effectiveWorkspaces: options?.effectiveWorkspaces ?? appState.workspaces,
      effectiveActiveWorkspaceId:
        options?.effectiveActiveWorkspaceId ?? appState.activeWorkspaceId,
      activeWorkspaceServersFlat: options?.activeWorkspaceServersFlat,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }),
  );
}

describe("useServerState OAuth callback failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    useClientConfigStore.setState({
      activeWorkspaceId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      clientCapabilitiesText: "{}",
      hostContextText: "{}",
      clientCapabilitiesError: null,
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    getStoredTokensMock.mockReturnValue(undefined);
    testConnectionMock.mockResolvedValue({
      success: true,
      initInfo: null,
    });
    completeHostedOAuthCallbackMock.mockReset();
    completeHostedOAuthCallbackMock.mockResolvedValue({
      success: false,
      error: "Hosted OAuth callback should be mocked per test",
    });
    initiateOAuthMock.mockResolvedValue({ success: true });
    readStoredOAuthConfigMock.mockReturnValue({
      registryServerId: undefined,
      useRegistryOAuthProxy: false,
    });
    mockConvexQuery.mockResolvedValue(null);
  });

  it("marks the pending server as failed when authorization is denied", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?error=access_denied&error_description=User%20denied%20access",
    );

    const dispatch = vi.fn();
    renderUseServerState(dispatch);

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "CONNECT_FAILURE",
        name: "demo-server",
        error: "access_denied: User denied access",
      });
    });

    expect(toastError).toHaveBeenCalledWith(
      "OAuth authorization failed: access_denied: User denied access",
    );
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#demo-server");
  });

  it("marks the pending server as failed when token exchange fails after redirect", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    handleOAuthCallbackMock.mockResolvedValue({
      success: false,
      error: "Token exchange failed",
    });
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const dispatch = vi.fn();
    renderUseServerState(dispatch);

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "CONNECT_FAILURE",
        name: "demo-server",
        error: "Token exchange failed",
      });
    });

    expect(toastError).toHaveBeenCalledWith(
      "Error completing OAuth flow: Token exchange failed",
    );
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
  });

  it("restores the app root after a successful browser OAuth callback", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    handleOAuthCallbackMock.mockResolvedValue({
      success: true,
      serverName: "demo-server",
      serverConfig: {
        type: "http",
        url: "https://example.com/mcp",
      },
    });
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const dispatch = vi.fn();
    renderUseServerState(dispatch);

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(
        "OAuth connection successful! Connected to demo-server.",
      );
    });

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#demo-server");
  });

  it("preserves existing HTTP config when OAuth callback returns a bearer token config", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    readStoredOAuthConfigMock.mockReturnValue({
      scopes: ["files:read", "files:write"],
      registryServerId: undefined,
      useRegistryOAuthProxy: false,
    });
    handleOAuthCallbackMock.mockResolvedValue({
      success: true,
      serverName: "demo-server",
      serverConfig: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer access-token",
          },
        },
      },
    });
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const appState = createAppState();
    const existingServer = {
      ...appState.servers["demo-server"],
      config: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            "X-Existing-Header": "present",
          },
        },
        timeout: 15000,
        clientCapabilities: {
          roots: {
            listChanged: true,
          },
        },
      } as any,
      oauthFlowProfile: {
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
      },
    };
    appState.servers["demo-server"] = existingServer;
    appState.workspaces.default.servers["demo-server"] = existingServer;

    const dispatch = vi.fn();
    renderUseServerState(dispatch, appState);

    await waitFor(() => {
      expect(testConnectionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com/mcp",
          requestInit: expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer access-token",
              "X-Existing-Header": "present",
            }),
          }),
          timeout: 15000,
          capabilities: {
            roots: {
              listChanged: true,
            },
          },
          clientCapabilities: {
            roots: {
              listChanged: true,
            },
          },
        }),
        "demo-server",
      );
    });

    const upsertAction = dispatch.mock.calls.find(
      ([action]) => action.type === "UPSERT_SERVER",
    )?.[0] as AppAction | undefined;
    expect(upsertAction).toMatchObject({
      type: "UPSERT_SERVER",
      name: "demo-server",
      server: {
        oauthFlowProfile: expect.objectContaining({
          scopes: "files:read,files:write",
        }),
      },
    });
  });

  it("blocks connect while workspace client config sync is pending", async () => {
    useClientConfigStore.setState({
      pendingWorkspaceId: "default",
      isAwaitingRemoteEcho: true,
    });

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch);

    await result.current.handleConnect({
      name: "new-server",
      type: "http",
      url: "https://example.com/mcp",
    });

    expect(toastError).toHaveBeenCalledWith(
      CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
    );
    expect(
      dispatch.mock.calls.some(([action]) => action.type === "CONNECT_REQUEST"),
    ).toBe(false);
  });

  it("applies workspace connection defaults on local reconnect", async () => {
    const { reconnectServer } = await import("@/state/mcp-api");
    const { ensureAuthorizedForReconnect } =
      await import("@/state/oauth-orchestrator");
    vi.mocked(reconnectServer).mockResolvedValue({
      success: true,
      initInfo: {
        clientCapabilities: {},
      },
    } as any);

    const appState = createAppState({
      workspaceClientConfig: {
        version: 1,
        connectionDefaults: {
          headers: {
            "X-Workspace-Header": "workspace",
          },
          requestTimeout: 30000,
        },
        clientCapabilities: {
          experimental: {
            workspaceProfile: {},
          },
        },
        hostContext: {},
      },
      serverCapabilities: {
        sampling: {},
      },
    });

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);
    vi.mocked(ensureAuthorizedForReconnect).mockResolvedValue({
      kind: "ready",
      serverConfig: appState.workspaces.default.servers["demo-server"].config,
      tokens: undefined,
    } as any);

    await result.current.handleReconnect("demo-server");

    await waitFor(() => {
      expect(vi.mocked(reconnectServer)).toHaveBeenCalled();
    });

    const [, effectiveConfig] = vi.mocked(reconnectServer).mock.calls[0] ?? [];
    expect(effectiveConfig).toMatchObject({
      requestInit: {
        headers: {
          "X-Workspace-Header": "workspace",
        },
      },
      timeout: 30000,
      capabilities: {
        experimental: {
          workspaceProfile: {},
        },
        sampling: {},
      },
      clientCapabilities: {
        experimental: {
          workspaceProfile: {},
        },
        sampling: {},
      },
    });
  });

  it("prefers an exact per-server clientCapabilities override over workspace capability merging", async () => {
    const { reconnectServer } = await import("@/state/mcp-api");
    const { ensureAuthorizedForReconnect } =
      await import("@/state/oauth-orchestrator");
    vi.mocked(reconnectServer).mockResolvedValue({
      success: true,
      initInfo: {
        clientCapabilities: {},
      },
    } as any);

    const appState = createAppState({
      workspaceClientConfig: {
        version: 1,
        connectionDefaults: {
          headers: {},
          requestTimeout: 10000,
        },
        clientCapabilities: {
          experimental: {
            workspaceProfile: {},
          },
        },
        hostContext: {},
      },
      serverCapabilities: {
        sampling: {},
      },
    });

    appState.workspaces.default.servers["demo-server"].config = {
      url: "https://example.com/mcp",
      capabilities: {
        sampling: {},
      },
      clientCapabilities: {
        roots: {
          listChanged: true,
        },
      },
    } as any;
    appState.servers["demo-server"].config =
      appState.workspaces.default.servers["demo-server"].config;

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);
    vi.mocked(ensureAuthorizedForReconnect).mockResolvedValue({
      kind: "ready",
      serverConfig: appState.workspaces.default.servers["demo-server"].config,
      tokens: undefined,
    } as any);

    await result.current.handleReconnect("demo-server");

    await waitFor(() => {
      expect(vi.mocked(reconnectServer)).toHaveBeenCalled();
    });

    const [, effectiveConfig] = vi.mocked(reconnectServer).mock.calls[0] ?? [];
    expect(effectiveConfig).toMatchObject({
      capabilities: {
        roots: {
          listChanged: true,
        },
      },
      clientCapabilities: {
        roots: {
          listChanged: true,
        },
      },
    });
  });

  it("resolves preregistered registry OAuth config before initiating Asana connect", async () => {
    mockConvexQuery.mockResolvedValueOnce({
      clientId: "asana-client-id",
      scopes: ["default"],
    });

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch);

    await act(async () => {
      await result.current.handleConnect({
        name: "Asana",
        type: "http",
        url: "https://mcp.asana.com/v2/mcp",
        useOAuth: true,
        registryServerId: "registry-asana",
        oauthScopes: ["fallback-scope"],
      });
    });

    expect(mockConvexQuery).toHaveBeenCalledWith(
      "registryServers:getRegistryServerOAuthConfig",
      { registryServerId: "registry-asana" },
    );
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "Asana",
        serverUrl: "https://mcp.asana.com/v2/mcp",
        clientId: "asana-client-id",
        clientSecret: undefined,
        registryServerId: "registry-asana",
        useRegistryOAuthProxy: true,
        scopes: ["default"],
      }),
    );
  });

  it("keeps Linear registry OAuth on the generic path when no preregistered client ID is returned", async () => {
    mockConvexQuery.mockResolvedValueOnce({
      scopes: ["read", "write"],
    });

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch);

    await act(async () => {
      await result.current.handleConnect({
        name: "Linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        useOAuth: true,
        registryServerId: "registry-linear",
        oauthScopes: ["fallback-scope"],
      });
    });

    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "Linear",
        serverUrl: "https://mcp.linear.app/mcp",
        clientId: undefined,
        clientSecret: undefined,
        registryServerId: "registry-linear",
        useRegistryOAuthProxy: false,
        scopes: ["read", "write"],
      }),
    );
  });

  it("fails registry OAuth initiation when the dedicated OAuth config query fails", async () => {
    mockConvexQuery.mockRejectedValueOnce(new Error("registry lookup failed"));

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch);

    await act(async () => {
      await result.current.handleConnect({
        name: "Asana",
        type: "http",
        url: "https://mcp.asana.com/v2/mcp",
        useOAuth: true,
        registryServerId: "registry-asana",
      });
    });

    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "CONNECT_FAILURE",
      name: "Asana",
      error: "Failed to resolve registry OAuth config: registry lookup failed",
    });
    expect(toastError).toHaveBeenCalledWith(
      "Network error: Failed to resolve registry OAuth config: registry lookup failed",
    );
  });
});

describe("useServerState auth mode regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    useClientConfigStore.setState({
      activeWorkspaceId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      clientCapabilitiesText: "{}",
      hostContextText: "{}",
      clientCapabilitiesError: null,
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    getStoredTokensMock.mockReturnValue(undefined);
    testConnectionMock.mockResolvedValue({
      success: true,
      initInfo: {},
    });
    initiateOAuthMock.mockResolvedValue({ success: true });
    mockConvexQuery.mockResolvedValue(null);
  });

  it("dispatches explicit non-OAuth success when updating an OAuth server to direct auth", async () => {
    const { deleteServer } = await import("@/state/mcp-api");
    vi.mocked(deleteServer).mockResolvedValue({ success: true } as any);

    const appState = createAppState();
    const oauthServer = {
      ...appState.servers["demo-server"],
      connectionStatus: "connected" as const,
      oauthTokens: {
        access_token: "expired-token",
        refresh_token: "refresh-token",
      },
      useOAuth: true,
    };
    appState.servers["demo-server"] = oauthServer as any;
    appState.workspaces.default.servers["demo-server"] = {
      ...oauthServer,
    } as any;

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);

    await act(async () => {
      await result.current.handleUpdate("demo-server", {
        name: "demo-server",
        type: "http",
        url: "https://example.com/mcp",
        useOAuth: false,
      });
    });

    const connectSuccessAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (
          action,
        ): action is Extract<AppAction, { type: "CONNECT_SUCCESS" }> =>
          action.type === "CONNECT_SUCCESS",
      );

    expect(connectSuccessAction).toMatchObject({
      type: "CONNECT_SUCCESS",
      name: "demo-server",
      useOAuth: false,
    });
    expect(clearOAuthDataMock).toHaveBeenCalledWith("demo-server");
    expect(initiateOAuthMock).not.toHaveBeenCalled();
  });

  it("keeps reconnects on the direct path once a server is marked non-OAuth", async () => {
    const { reconnectServer } = await import("@/state/mcp-api");
    const { ensureAuthorizedForReconnect } =
      await import("@/state/oauth-orchestrator");
    vi.mocked(reconnectServer).mockResolvedValue({
      success: true,
      initInfo: {},
    } as any);

    const appState = createAppState();
    const directServer = {
      ...appState.servers["demo-server"],
      connectionStatus: "connected" as const,
      oauthTokens: undefined,
      useOAuth: false,
    };
    appState.servers["demo-server"] = directServer as any;
    appState.workspaces.default.servers["demo-server"] = {
      ...directServer,
    } as any;

    vi.mocked(ensureAuthorizedForReconnect).mockResolvedValue({
      kind: "ready",
      serverConfig: directServer.config,
      tokens: undefined,
    } as any);

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);

    await act(async () => {
      await result.current.handleReconnect("demo-server");
    });

    expect(vi.mocked(ensureAuthorizedForReconnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo-server",
        useOAuth: false,
      }),
      expect.any(Object),
    );

    const connectSuccessAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (
          action,
        ): action is Extract<AppAction, { type: "CONNECT_SUCCESS" }> =>
          action.type === "CONNECT_SUCCESS",
      );

    expect(connectSuccessAction).toMatchObject({
      type: "CONNECT_SUCCESS",
      name: "demo-server",
      useOAuth: false,
      tokens: undefined,
    });
    expect(initiateOAuthMock).not.toHaveBeenCalled();
  });
});

describe("useServerState authenticated fallback persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    useClientConfigStore.setState({
      activeWorkspaceId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      clientCapabilitiesText: "{}",
      hostContextText: "{}",
      clientCapabilitiesError: null,
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    getStoredTokensMock.mockReturnValue(undefined);
    testConnectionMock.mockResolvedValue({
      success: true,
      initInfo: null,
    });
    initiateOAuthMock.mockResolvedValue({ success: true });
    mockConvexQuery.mockResolvedValue(null);
  });

  it("persists saved server configs into the local workspace in authenticated fallback mode", async () => {
    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, createAppState(), {
      isAuthenticated: true,
      useLocalFallback: true,
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.saveServerConfigWithoutConnecting({
        name: "saved-fallback",
        type: "http",
        url: "https://fallback.example/mcp",
      });
    });

    const updateWorkspaceAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action): action is Extract<AppAction, { type: "UPDATE_WORKSPACE" }> =>
          action.type === "UPDATE_WORKSPACE",
      );

    expect(updateWorkspaceAction).toMatchObject({
      type: "UPDATE_WORKSPACE",
      workspaceId: "default",
    });
    expect(updateWorkspaceAction?.updates.servers).toEqual(
      expect.objectContaining({
        "demo-server": expect.any(Object),
        "saved-fallback": expect.objectContaining({
          name: "saved-fallback",
        }),
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "Saved configuration for saved-fallback",
    );
  });

  it("persists renamed servers into the local workspace in authenticated fallback mode", async () => {
    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, createAppState(), {
      isAuthenticated: true,
      useLocalFallback: true,
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleUpdate(
        "demo-server",
        {
          name: "renamed-server",
          type: "http",
          url: "https://example.com/mcp",
          useOAuth: true,
        },
        true,
      );
    });

    const updateWorkspaceAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action): action is Extract<AppAction, { type: "UPDATE_WORKSPACE" }> =>
          action.type === "UPDATE_WORKSPACE",
      );

    expect(updateWorkspaceAction).toMatchObject({
      type: "UPDATE_WORKSPACE",
      workspaceId: "default",
    });
    expect(
      updateWorkspaceAction?.updates.servers["demo-server"],
    ).toBeUndefined();
    expect(updateWorkspaceAction?.updates.servers["renamed-server"]).toEqual(
      expect.objectContaining({
        name: "renamed-server",
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Server configuration updated");
  });
});

describe("useServerState OAuth callback in-flight dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("dispatches CONNECT_REQUEST for the pending server before token exchange completes", async () => {
    const { listServers } = await import("@/state/mcp-api");
    vi.mocked(listServers).mockResolvedValue({ success: true, servers: [] } as any);

    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    localStorage.setItem("mcp-serverUrl-demo-server", "https://example.com/mcp");

    // Slow token exchange — controllable promise so we can assert before it resolves
    let resolveTokenExchange!: (value: unknown) => void;
    handleOAuthCallbackMock.mockReturnValue(
      new Promise((resolve) => {
        resolveTokenExchange = resolve;
      }),
    );

    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const dispatch = vi.fn();
    renderUseServerState(dispatch);

    // The early CONNECT_REQUEST must fire before the token exchange resolves
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_REQUEST",
          name: "demo-server",
        }),
      );
    });

    // Token exchange hasn't finished yet — no CONNECT_SUCCESS dispatched
    expect(
      dispatch.mock.calls.some(([a]) => a.type === "CONNECT_SUCCESS"),
    ).toBe(false);

    // Now let the token exchange complete and verify the full happy path
    resolveTokenExchange({
      success: true,
      serverName: "demo-server",
      serverConfig: { type: "http", url: "https://example.com/mcp" },
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_SUCCESS",
          name: "demo-server",
          useOAuth: true,
        }),
      );
    });
  });
});
