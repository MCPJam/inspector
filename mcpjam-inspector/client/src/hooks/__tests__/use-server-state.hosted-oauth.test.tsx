import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useServerState } from "../use-server-state";
import { writeHostedOAuthPendingMarker } from "@/lib/hosted-oauth-callback";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";

const {
  mockHandleOAuthCallback,
  mockListServers,
  mockReconnectServer,
  mockEnsureAuthorizedForReconnect,
  mockUseServerMutations,
  mockConvexQuery,
  testConnectionMock,
  readStoredOAuthConfigMock,
  toastSuccess,
} = vi.hoisted(() => ({
  mockHandleOAuthCallback: vi.fn(),
  mockListServers: vi.fn(),
  mockReconnectServer: vi.fn(),
  mockEnsureAuthorizedForReconnect: vi.fn(),
  mockUseServerMutations: vi.fn(() => ({
    createServer: vi.fn(),
    updateServer: vi.fn(),
    deleteServer: vi.fn(),
  })),
  mockConvexQuery: vi.fn(),
  testConnectionMock: vi.fn(),
  readStoredOAuthConfigMock: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: mockConvexQuery,
  }),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/state/mcp-api", () => ({
  testConnection: testConnectionMock,
  deleteServer: vi.fn(),
  listServers: mockListServers,
  reconnectServer: mockReconnectServer,
  getInitializationInfo: vi.fn(),
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: mockEnsureAuthorizedForReconnect,
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  completeHostedOAuthCallback: mockHandleOAuthCallback,
  handleOAuthCallback: mockHandleOAuthCallback,
  getStoredTokens: vi.fn(),
  clearOAuthData: vi.fn(),
  initiateOAuth: vi.fn(),
  readStoredOAuthConfig: readStoredOAuthConfigMock,
}));

vi.mock("@/lib/apis/web/context", () => ({
  injectHostedServerMapping: vi.fn(),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: {
    getState: () => ({
      setCspMode: vi.fn(),
      setMcpAppsCspMode: vi.fn(),
    }),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
  },
}));

vi.mock("../useWorkspaces", () => ({
  useServerMutations: mockUseServerMutations,
}));

function renderHostedServerState(
  dispatch = vi.fn(),
  options?: {
    workspaceClientConfig?: {
      version: 1;
      clientCapabilities: Record<string, unknown>;
      hostContext: Record<string, unknown>;
    };
  },
) {
  return renderHook(() =>
    useServerState({
      appState: {
        activeWorkspaceId: "ws_1",
        workspaces: {
          ws_1: {
            id: "ws_1",
            name: "Workspace",
            clientConfig: options?.workspaceClientConfig,
            servers: {
              asana: {
                name: "asana",
                config: {
                  type: "http",
                  url: "https://mcp.asana.com/sse",
                },
                lastConnectionTime: new Date(),
                connectionStatus: "disconnected",
                retryCount: 0,
                enabled: true,
                useOAuth: true,
              },
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        servers: {
          asana: {
            name: "asana",
            config: {
              type: "http",
              url: "https://mcp.asana.com/sse",
            },
            lastConnectionTime: new Date(),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
          },
        },
        selectedServer: "asana",
        selectedMultipleServers: [],
        isMultiSelectMode: false,
      } as any,
      dispatch,
      isLoading: false,
      isAuthenticated: true,
      isAuthLoading: false,
      isLoadingWorkspaces: false,
      useLocalFallback: false,
      effectiveWorkspaces: {
        ws_1: {
          id: "ws_1",
          name: "Workspace",
          clientConfig: options?.workspaceClientConfig,
          servers: {
            asana: {
              name: "asana",
              config: {
                type: "http",
                url: "https://mcp.asana.com/sse",
              },
              lastConnectionTime: new Date(),
              connectionStatus: "disconnected",
              retryCount: 0,
              enabled: true,
              useOAuth: true,
            },
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as any,
      effectiveActiveWorkspaceId: "ws_1",
      activeWorkspaceServersFlat: [{ _id: "srv_asana", name: "asana" }],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }),
  );
}

describe("useServerState hosted OAuth callback guards", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/?code=oauth-code");
    mockHandleOAuthCallback.mockReset();
    mockListServers.mockReset();
    mockReconnectServer.mockReset();
    mockEnsureAuthorizedForReconnect.mockReset();
    mockConvexQuery.mockReset();
    testConnectionMock.mockReset();
    readStoredOAuthConfigMock.mockReset();
    toastSuccess.mockReset();
    mockListServers.mockResolvedValue({ success: true, servers: [] });
    mockReconnectServer.mockResolvedValue({
      success: true,
      initInfo: {},
    });
    testConnectionMock.mockResolvedValue({
      success: true,
      initInfo: {},
    });
    readStoredOAuthConfigMock.mockReturnValue({});
  });

  it("defers hosted chatbox OAuth callbacks to App.tsx", async () => {
    writeHostedOAuthPendingMarker({
      surface: "chatbox",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      returnHash: "#asaan",
    });
    localStorage.setItem("mcp-oauth-pending", "asana");
    localStorage.setItem("mcp-serverUrl-asana", "https://mcp.asana.com/sse");

    renderHook(() =>
      useServerState({
        appState: {
          servers: {},
          selectedMultipleServers: [],
        } as any,
        dispatch: vi.fn(),
        isLoading: false,
        isAuthenticated: true,
        isAuthLoading: false,
        isLoadingWorkspaces: false,
        useLocalFallback: false,
        effectiveWorkspaces: {} as any,
        effectiveActiveWorkspaceId: "ws_1",
        activeWorkspaceServersFlat: [],
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("completes hosted workspace OAuth callbacks through the backend path", async () => {
    writeHostedOAuthPendingMarker({
      surface: "workspace",
      workspaceId: "ws_1",
      serverId: "srv_asana",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      accessScope: "workspace_member",
      returnHash: "#servers",
    });
    localStorage.setItem("mcp-oauth-pending", "asana");
    localStorage.setItem("mcp-serverUrl-asana", "https://mcp.asana.com/sse");
    mockHandleOAuthCallback.mockResolvedValue({
      success: true,
      serverName: "asana",
      serverConfig: {
        url: "https://mcp.asana.com/sse",
        requestInit: { headers: {} },
      },
    });

    const dispatch = vi.fn();

    renderHook(() =>
      useServerState({
        appState: {
          servers: {},
          selectedMultipleServers: [],
        } as any,
        dispatch,
        isLoading: false,
        isAuthenticated: true,
        isAuthLoading: false,
        isLoadingWorkspaces: false,
        useLocalFallback: false,
        effectiveWorkspaces: {} as any,
        effectiveActiveWorkspaceId: "ws_1",
        activeWorkspaceServersFlat: [],
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(mockHandleOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "workspace",
          workspaceId: "ws_1",
          serverId: "srv_asana",
          serverName: "asana",
        }),
        "oauth-code",
        expect.objectContaining({
          onTraceUpdate: expect.any(Function),
        }),
      );
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_SUCCESS",
          name: "asana",
          useOAuth: true,
          tokens: undefined,
        }),
      );
    });
  });

  it("forwards the OAuth callback state parameter to completeHostedOAuthCallback", async () => {
    window.history.replaceState(
      {},
      "",
      "/?code=oauth-code&state=expected-state-token",
    );
    writeHostedOAuthPendingMarker({
      surface: "workspace",
      workspaceId: "ws_1",
      serverId: "srv_asana",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      accessScope: "workspace_member",
      returnHash: "#servers",
    });
    localStorage.setItem("mcp-oauth-pending", "asana");
    localStorage.setItem("mcp-serverUrl-asana", "https://mcp.asana.com/sse");
    mockHandleOAuthCallback.mockResolvedValue({
      success: true,
      serverName: "asana",
      serverConfig: {
        url: "https://mcp.asana.com/sse",
        requestInit: { headers: {} },
      },
    });

    renderHook(() =>
      useServerState({
        appState: {
          servers: {},
          selectedMultipleServers: [],
        } as any,
        dispatch: vi.fn(),
        isLoading: false,
        isAuthenticated: true,
        isAuthLoading: false,
        isLoadingWorkspaces: false,
        useLocalFallback: false,
        effectiveWorkspaces: {} as any,
        effectiveActiveWorkspaceId: "ws_1",
        activeWorkspaceServersFlat: [],
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(mockHandleOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "workspace",
          serverName: "asana",
        }),
        "oauth-code",
        expect.objectContaining({
          callbackState: "expected-state-token",
          onTraceUpdate: expect.any(Function),
        }),
      );
    });
  });

  it("reuses hosted stored OAuth credentials on reconnect before falling back to interactive OAuth", async () => {
    const workspaceClientConfig = {
      version: 1 as const,
      clientCapabilities: {
        ...(getDefaultClientCapabilities() as Record<string, unknown>),
        experimental: {
          workspaceProfile: {},
        },
      },
      hostContext: {},
    };
    const dispatch = vi.fn();
    const { result } = renderHostedServerState(dispatch, {
      workspaceClientConfig,
    });

    await act(async () => {
      await result.current.handleReconnect("asana");
    });

    await waitFor(() => {
      expect(mockReconnectServer).toHaveBeenCalledWith(
        "asana",
        expect.objectContaining({
          type: "http",
          url: "https://mcp.asana.com/sse",
          clientCapabilities: expect.objectContaining({
            experimental: {
              workspaceProfile: {},
            },
          }),
        }),
      );
    });

    expect(mockEnsureAuthorizedForReconnect).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONNECT_SUCCESS",
        name: "asana",
        useOAuth: true,
        tokens: undefined,
        config: expect.not.objectContaining({
          clientCapabilities: expect.anything(),
        }),
      }),
    );
  });

  it("falls back to interactive OAuth when hosted stored-auth reconnect says authorization is required", async () => {
    mockReconnectServer.mockResolvedValueOnce({
      success: false,
      error:
        'Server "srv_asana" requires OAuth authentication. Please complete the OAuth flow first.',
    });
    mockEnsureAuthorizedForReconnect.mockResolvedValueOnce({
      kind: "error",
      error: "OAuth init failed",
    });

    const dispatch = vi.fn();
    const { result } = renderHostedServerState(dispatch);

    await act(async () => {
      await result.current.handleReconnect("asana");
    });

    await waitFor(() => {
      expect(mockEnsureAuthorizedForReconnect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "asana",
          useOAuth: true,
        }),
        expect.objectContaining({
          allowInteractiveOAuthFlow: true,
          beforeRedirect: expect.any(Function),
        }),
      );
    });
  });

  it("also falls back to interactive OAuth when hosted reconnect throws the same auth error", async () => {
    mockReconnectServer.mockRejectedValueOnce(
      new Error(
        'Server "srv_asana" requires OAuth authentication. Please complete the OAuth flow first.',
      ),
    );
    mockEnsureAuthorizedForReconnect.mockResolvedValueOnce({
      kind: "error",
      error: "OAuth init failed",
    });

    const dispatch = vi.fn();
    const { result } = renderHostedServerState(dispatch);

    await act(async () => {
      await result.current.handleReconnect("asana");
    });

    await waitFor(() => {
      expect(mockEnsureAuthorizedForReconnect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "asana",
          useOAuth: true,
        }),
        expect.objectContaining({
          allowInteractiveOAuthFlow: true,
          beforeRedirect: expect.any(Function),
        }),
      );
    });
  });

  it("falls back to interactive OAuth when hosted reconnect reports a missing refresh token", async () => {
    mockReconnectServer.mockResolvedValueOnce({
      success: false,
      error: "Stored hosted OAuth credential is missing refresh_token",
    });
    mockEnsureAuthorizedForReconnect.mockResolvedValueOnce({
      kind: "error",
      error: "OAuth init failed",
    });

    const dispatch = vi.fn();
    const { result } = renderHostedServerState(dispatch);

    await act(async () => {
      await result.current.handleReconnect("asana");
    });

    await waitFor(() => {
      expect(mockEnsureAuthorizedForReconnect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "asana",
          useOAuth: true,
        }),
        expect.objectContaining({
          allowInteractiveOAuthFlow: true,
          beforeRedirect: expect.any(Function),
        }),
      );
    });
  });

  it("reports reauth instead of launching interactive OAuth during automatic readiness checks", async () => {
    mockReconnectServer.mockResolvedValueOnce({
      success: false,
      error:
        'Server "srv_asana" requires OAuth authentication. Please complete the OAuth flow first.',
    });
    mockEnsureAuthorizedForReconnect.mockResolvedValueOnce({
      kind: "reauth_required",
      error: "OAuth consent is required for asana. Click Reconnect to continue.",
    });

    const dispatch = vi.fn();
    const { result } = renderHostedServerState(dispatch);
    let readiness:
      | Awaited<ReturnType<typeof result.current.ensureServersReady>>
      | undefined;

    await act(async () => {
      readiness = await result.current.ensureServersReady(["asana"]);
    });

    expect(mockEnsureAuthorizedForReconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "asana",
        useOAuth: true,
      }),
      expect.objectContaining({
        allowInteractiveOAuthFlow: false,
        beforeRedirect: expect.any(Function),
      }),
    );
    expect(readiness).toEqual({
      readyServerNames: [],
      missingServerNames: [],
      failedServerNames: [],
      reauthServerNames: ["asana"],
    });
  });
});
