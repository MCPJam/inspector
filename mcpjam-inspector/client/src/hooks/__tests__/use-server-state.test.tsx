import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AppAction } from "@/state/app-types";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
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

function createAppState(): AppState {
  return {
    workspaces: {
      default: {
        id: "default",
        name: "Default",
        servers: {
          "demo-server": {
            name: "demo-server",
            config: {
              type: "http",
              url: "https://example.com/mcp",
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

function renderUseServerState(dispatch: (action: AppAction) => void) {
  const appState = createAppState();
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
});
