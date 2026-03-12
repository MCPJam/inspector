import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useServerState } from "../use-server-state";
import { writeHostedOAuthPendingMarker } from "@/lib/hosted-oauth-callback";

const {
  mockHandleOAuthCallback,
  mockListServers,
  mockUseServerMutations,
  toastSuccess,
} = vi.hoisted(() => ({
  mockHandleOAuthCallback: vi.fn(),
  mockListServers: vi.fn(),
  mockUseServerMutations: vi.fn(() => ({
    createServer: vi.fn(),
    updateServer: vi.fn(),
    deleteServer: vi.fn(),
  })),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/state/mcp-api", () => ({
  testConnection: vi.fn(),
  deleteServer: vi.fn(),
  listServers: mockListServers,
  reconnectServer: vi.fn(),
  getInitializationInfo: vi.fn(),
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
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

describe("useServerState hosted OAuth callback guards", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/?code=oauth-code");
    mockHandleOAuthCallback.mockReset();
    mockListServers.mockReset();
    toastSuccess.mockReset();
    mockListServers.mockResolvedValue({ success: true, servers: [] });
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
});
