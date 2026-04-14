import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AppAction } from "@/state/app-types";
import {
  buildElectronMcpCallbackUrl,
  shouldRetryOAuthConnectionFailure,
  useServerState,
} from "../use-server-state";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
import type { WorkspaceClientConfig } from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";

const {
  toastError,
  toastSuccess,
  handleOAuthCallbackMock,
  initiateOAuthMock,
  getStoredTokensMock,
  clearOAuthDataMock,
  testConnectionMock,
  mockConvexQuery,
} = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  handleOAuthCallbackMock: vi.fn(),
  initiateOAuthMock: vi.fn(),
  getStoredTokensMock: vi.fn(),
  clearOAuthDataMock: vi.fn(),
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
  getInitializationInfo: vi.fn().mockResolvedValue({
    success: false,
  }),
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/oauth/mcp-oauth")>();
  return {
    ...actual,
    handleOAuthCallback: handleOAuthCallbackMock,
    getStoredTokens: getStoredTokensMock,
    clearOAuthData: clearOAuthDataMock,
    initiateOAuth: initiateOAuthMock,
  };
});

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

async function flushAsyncWork(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
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
    initiateOAuthMock.mockResolvedValue({ success: true });
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

  it("bounces browser OAuth callbacks back into Electron when the OAuth state is tagged for desktop", async () => {
    window.isElectron = false;
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?code=test-code&state=electron_mcp:test-state",
    );

    expect(buildElectronMcpCallbackUrl()).toBe(
      "mcpjam://oauth/callback?flow=mcp&code=test-code&state=electron_mcp%3Atest-state",
    );
  });

  it("defers Electron-tagged browser callbacks to the App-level desktop return notice", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    window.isElectron = false;
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?code=test-code&state=electron_mcp:test-state",
    );

    try {
      const dispatch = vi.fn();
      renderUseServerState(dispatch);
      await flushAsyncWork();

      expect(handleOAuthCallbackMock).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        "Not implemented: navigation to another Document",
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("ignores regular browser OAuth callbacks that are not tagged for Electron", () => {
    window.isElectron = false;
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?code=test-code&state=test-state",
    );

    expect(buildElectronMcpCallbackUrl()).toBeNull();
  });

  it("detects retryable transport errors after OAuth", () => {
    expect(
      shouldRetryOAuthConnectionFailure(
        "Streamable HTTP error: Request timed out. SSE error: SSE error: Non-200 status code (404).",
      ),
    ).toBe(true);
    expect(
      shouldRetryOAuthConnectionFailure(
        "OAuth failed with invalid_client from the authorization server",
      ),
    ).toBe(false);
  });

  it("retries transient connection failures once after a successful OAuth callback", async () => {
    vi.useFakeTimers();

    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem(
      "mcp-serverUrl-demo-server",
      "https://example.com/mcp",
    );
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    handleOAuthCallbackMock.mockResolvedValue({
      success: true,
      serverName: "demo-server",
      serverConfig: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer token",
          },
        },
      },
    });
    getStoredTokensMock.mockReturnValue({
      access_token: "token",
    } as any);
    testConnectionMock
      .mockResolvedValueOnce({
        success: false,
        error:
          'Connection failed for server demo-server: Failed to connect to MCP server "demo-server" using HTTP transports. Streamable HTTP error: Request timed out. SSE error: SSE error: Non-200 status code (404).',
      } as any)
      .mockResolvedValueOnce({
        success: true,
        initInfo: null,
      } as any);

    try {
      const dispatch = vi.fn();
      renderUseServerState(dispatch);

      await act(async () => {
        await flushAsyncWork();
      });

      expect(handleOAuthCallbackMock).toHaveBeenCalledWith("test-code");
      expect(testConnectionMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
        await flushAsyncWork();
      });

      expect(testConnectionMock).toHaveBeenCalledTimes(2);

      expect(toastSuccess).toHaveBeenCalledWith(
        "OAuth connection successful! Connected to demo-server.",
      );
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_SUCCESS",
          name: "demo-server",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("passes exact workspace-derived clientCapabilities on local reconnect", async () => {
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
      capabilities: {
        experimental: {
          workspaceProfile: {},
        },
        sampling: {},
        elicitation: {},
      },
      clientCapabilities: {
        experimental: {
          workspaceProfile: {},
        },
        sampling: {},
        elicitation: {},
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
    expect(initiateOAuthMock).toHaveBeenCalledWith({
      serverName: "Asana",
      serverUrl: "https://mcp.asana.com/v2/mcp",
      clientId: "asana-client-id",
      clientSecret: undefined,
      registryServerId: "registry-asana",
      useRegistryOAuthProxy: true,
      scopes: ["default"],
    });
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

    expect(initiateOAuthMock).toHaveBeenCalledWith({
      serverName: "Linear",
      serverUrl: "https://mcp.linear.app/mcp",
      clientId: undefined,
      clientSecret: undefined,
      registryServerId: "registry-linear",
      useRegistryOAuthProxy: false,
      scopes: ["read", "write"],
    });
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
