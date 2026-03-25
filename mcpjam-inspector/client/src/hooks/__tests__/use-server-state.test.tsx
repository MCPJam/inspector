import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AppAction } from "@/state/app-types";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
import type { WorkspaceClientConfig } from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useServerState } from "../use-server-state";

const { toastError, toastSuccess, handleOAuthCallbackMock } = vi.hoisted(
  () => ({
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    handleOAuthCallbackMock: vi.fn(),
  }),
);

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

vi.mock("@/state/mcp-api", () => ({
  testConnection: vi.fn(),
  deleteServer: vi.fn(),
  listServers: vi.fn(),
  reconnectServer: vi.fn(),
  getInitializationInfo: vi.fn(),
  testRuntimeServerConnection: vi.fn(),
  reconnectRuntimeServer: vi.fn(),
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  handleOAuthCallback: handleOAuthCallbackMock,
  getStoredTokens: vi.fn(),
  clearOAuthData: vi.fn(),
  initiateOAuth: vi.fn(),
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
) {
  return renderHook(() =>
    useServerState({
      appState,
      dispatch,
      isLoading: false,
      isAuthenticated: false,
      isAuthLoading: false,
      isLoadingWorkspaces: false,
      useLocalFallback: true,
      effectiveWorkspaces: appState.workspaces,
      effectiveActiveWorkspaceId: appState.activeWorkspaceId,
      activeWorkspaceServersFlat: undefined,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }),
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
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

  it("invalidates in-flight runtime connects before removing the runtime server", async () => {
    const deferred = createDeferred<any>();
    const dispatch = vi.fn();
    const appState = createAppState();
    appState.servers.__learning__ = {
      name: "__learning__",
      config: { url: "https://learn.mcpjam.com/mcp" } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "connecting",
      retryCount: 0,
      enabled: true,
      surface: "learning",
    };

    const { testRuntimeServerConnection, deleteServer } = await import(
      "@/state/mcp-api"
    );
    vi.mocked(testRuntimeServerConnection).mockReturnValue(deferred.promise);
    vi.mocked(deleteServer).mockResolvedValue({ success: true } as any);

    const { result } = renderUseServerState(dispatch, appState);
    const connectPromise = result.current.connectRuntimeServer({
      name: "__learning__",
      config: { url: "https://learn.mcpjam.com/mcp" } as any,
      surface: "learning",
    });

    await result.current.disconnectRuntimeServer("__learning__");
    deferred.resolve({
      success: true,
      initInfo: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "learning", version: "1.0.0" },
      },
    });
    await connectPromise;

    expect(dispatch).toHaveBeenCalledWith({
      type: "REMOVE_SERVER",
      name: "__learning__",
    });
    expect(
      dispatch.mock.calls.some(
        ([action]) =>
          action.type === "CONNECT_SUCCESS" && action.name === "__learning__",
      ),
    ).toBe(false);
  });

  it("selects only connected servers from the active workspace", () => {
    const dispatch = vi.fn();
    const appState = createAppState();
    const workspaceServer = {
      ...appState.servers["demo-server"],
      connectionStatus: "connected" as const,
    };
    appState.workspaces.default.servers["demo-server"] = workspaceServer;
    appState.workspaces.default.servers["other-workspace-server"] = {
      ...workspaceServer,
      name: "other-workspace-server",
    };
    appState.servers = {
      "demo-server": workspaceServer,
      "other-workspace-server": {
        ...workspaceServer,
        name: "other-workspace-server",
      },
      "__learning__": {
        name: "__learning__",
        config: { url: "https://learn.mcpjam.com/mcp" } as any,
        lastConnectionTime: new Date(),
        connectionStatus: "connected",
        retryCount: 0,
        enabled: true,
        surface: "learning",
      },
    };
    delete appState.workspaces.default.servers["other-workspace-server"];

    const { result } = renderUseServerState(dispatch, appState);
    result.current.setSelectedMultipleServersToAllServers();

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_MULTI_SELECTED",
      names: ["demo-server"],
    });
  });
});
