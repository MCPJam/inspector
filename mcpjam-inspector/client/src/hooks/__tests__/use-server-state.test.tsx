import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AppAction } from "@/state/app-types";
import {
  buildElectronMcpCallbackUrl,
  shouldRetryOAuthConnectionFailure,
  useServerState,
} from "../use-server-state";
import { testConnection } from "@/state/mcp-api";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";

const {
  toastError,
  toastSuccess,
  handleOAuthCallbackMock,
  getStoredTokensMock,
} = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  handleOAuthCallbackMock: vi.fn(),
  getStoredTokensMock: vi.fn(),
}));

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
  getInitializationInfo: vi.fn().mockResolvedValue({
    success: false,
  }),
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  handleOAuthCallback: handleOAuthCallbackMock,
  getStoredTokens: getStoredTokensMock,
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

  it("bounces browser OAuth callbacks back into Electron when no pending browser state exists", async () => {
    window.isElectron = false;
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?code=test-code&state=test-state",
    );

    expect(buildElectronMcpCallbackUrl()).toBe(
      "mcpjam://oauth/callback?flow=mcp&code=test-code&state=test-state",
    );
  });

  it("detects retryable transport errors after OAuth", () => {
    expect(
      shouldRetryOAuthConnectionFailure(
        'Streamable HTTP error: Request timed out. SSE error: SSE error: Non-200 status code (404).',
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
    localStorage.setItem("mcp-serverUrl-demo-server", "https://example.com/mcp");
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
    vi.mocked(getStoredTokens).mockReturnValue({
      access_token: "token",
    } as any);
    vi.mocked(testConnection)
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
      expect(testConnection).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
        await flushAsyncWork();
      });

      expect(testConnection).toHaveBeenCalledTimes(2);

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
});
