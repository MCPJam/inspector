import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useServerState } from "../use-server-state";
import { writeHostedOAuthPendingMarker } from "@/lib/hosted-oauth-callback";

const {
  mockHandleOAuthCallback,
  mockListServers,
  mockReconnectServer,
  mockEnsureAuthorizedForReconnect,
  mockUseServerMutations,
  mockConvexQuery,
  testConnectionMock,
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

function renderHostedServerState(dispatch = vi.fn()) {
  return renderHook(() =>
    useServerState({
      appState: {
        activeWorkspaceId: "ws_1",
        workspaces: {
          ws_1: {
            id: "ws_1",
            name: "Workspace",
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
  });

  it("defers hosted sandbox OAuth callbacks to App.tsx", async () => {
    writeHostedOAuthPendingMarker({
      surface: "sandbox",
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

  it("reuses hosted stored OAuth credentials on reconnect before falling back to interactive OAuth", async () => {
    const dispatch = vi.fn();
    const { result } = renderHostedServerState(dispatch);

    await act(async () => {
      await result.current.handleReconnect("asana");
    });

    await waitFor(() => {
      expect(mockReconnectServer).toHaveBeenCalledWith(
        "asana",
        expect.objectContaining({
          type: "http",
          url: "https://mcp.asana.com/sse",
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
      }),
    );
  });

  it("falls back to interactive OAuth when hosted stored-auth reconnect says authorization is required", async () => {
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
          beforeRedirect: expect.any(Function),
        }),
      );
    });
  });
});
