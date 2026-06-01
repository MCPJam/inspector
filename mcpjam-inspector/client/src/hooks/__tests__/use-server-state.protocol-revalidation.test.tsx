/**
 * Re-validation effect: when the active host's resolved per-server
 * `mcpProtocolVersion` changes for an already-connected server, the hook
 * should re-test the connection (via the existing reconnect path) and
 * dispatch CONNECT_SUCCESS or CONNECT_FAILURE so the durable toggle
 * reflects whether the server actually speaks the new pin.
 *
 * Lives in its own file because the broader `use-server-state.test.tsx`
 * has `flushSync` + nested `act` patterns in earlier suites that leave
 * RTL's renderHook root in a state where subsequent renders return
 * `result.current === null`. Splitting into a fresh test file keeps the
 * React root clean for these rerender-driven assertions.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AppAction } from "@/state/app-types";
import { useServerState } from "../use-server-state";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/client-context-store";

const {
  reconnectServerMock,
  tryResolveProjectServerMock,
  getStoredTokensMock,
  getInitializationInfoMock,
  mockUseDbUserReady,
} = vi.hoisted(() => ({
  reconnectServerMock: vi.fn(),
  tryResolveProjectServerMock: vi.fn<
    (serverNameOrId: string) => { projectId: string; serverId: string } | null
  >(() => null),
  getStoredTokensMock: vi.fn(),
  getInitializationInfoMock: vi.fn(),
  mockUseDbUserReady: vi.fn(() => true),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: mockUseDbUserReady,
}));

vi.mock("@/state/mcp-api", () => ({
  testConnection: vi.fn(),
  deleteServer: vi.fn(),
  listServers: vi.fn(),
  reconnectServer: reconnectServerMock,
  getInitializationInfo: getInitializationInfoMock,
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/oauth/mcp-oauth")>();
  return {
    ...actual,
    completeHostedOAuthCallback: vi.fn(),
    handleOAuthCallback: vi.fn(),
    getStoredTokens: getStoredTokensMock,
    clearOAuthData: vi.fn(),
    initiateOAuth: vi.fn(),
    readStoredOAuthConfig: vi.fn(),
  };
});

vi.mock("@/lib/apis/web/context", () => ({
  injectHostedServerMapping: vi.fn(),
  tryGetHostedServerDisplayName: vi.fn(),
  tryResolveProjectServer: tryResolveProjectServerMock,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(async () => ({ json: async () => ({}) })),
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: {
    getState: vi.fn(() => ({ setSelectedToolResult: vi.fn() })),
  },
}));

vi.mock("../useProjects", () => ({
  useServerMutations: () => ({
    createServer: vi.fn(),
    createServerIfMissing: vi.fn(),
    updateServer: vi.fn(),
    deleteServer: vi.fn(),
    createServerWithClientSecret: vi.fn(),
    updateServerWithClientSecret: vi.fn(),
  }),
}));

function buildConnectedAppState(): AppState {
  return {
    projects: {
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
            connectionStatus: "connected",
            retryCount: 0,
            enabled: true,
            useOAuth: false,
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: true,
      },
    },
    activeProjectId: "default",
    servers: {
      "demo-server": {
        name: "demo-server",
        config: {
          type: "http",
          url: "https://example.com/mcp",
        } as any,
        lastConnectionTime: new Date(),
        connectionStatus: "connected",
        retryCount: 0,
        enabled: true,
        useOAuth: false,
      },
    },
    selectedServer: "demo-server",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

type Profile = { mcpProtocolVersion?: string } | undefined;
type HostOverrides =
  | Record<string, { mcpProtocolVersionOverride?: string }>
  | undefined;

function buildHostConfig(overrides?: HostOverrides): any {
  return {
    profileVersion: 1,
    connectionDefaults: { headers: {}, requestTimeout: 30000 },
    clientCapabilities: {},
    ...(overrides ? { serverConnectionOverrides: overrides } : {}),
  };
}

function renderRevalidationHook(
  dispatch: (action: AppAction) => void,
  initial: { profile: Profile; hostConfig: any },
) {
  const appState = buildConnectedAppState();
  const state = { ...initial };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const hook = renderHook(() =>
    useServerState({
      appState,
      dispatch,
      isLoading: false,
      isAuthenticated: false,
      hasSignedInUser: false,
      isAuthLoading: false,
      isLoadingProjects: false,
      useLocalFallback: true,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: appState.activeProjectId,
      activeProjectServersFlat: undefined,
      activeMcpProfile: state.profile as any,
      activeHostConfig: state.hostConfig,
      logger,
    }),
  );
  return {
    ...hook,
    rerender: (next: { profile: Profile; hostConfig: any }) => {
      state.profile = next.profile;
      state.hostConfig = next.hostConfig;
      hook.rerender();
    },
  };
}

async function flushAsyncWork(iterations = 5): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  useClientConfigStore.setState({
    pendingProjectId: null,
    isAwaitingRemoteEcho: false,
  });
  useHostContextStore.setState({
    pendingProjectId: null,
    isAwaitingRemoteEcho: false,
  });
  reconnectServerMock.mockReset();
  tryResolveProjectServerMock.mockReturnValue({
    projectId: "project_default",
    serverId: "srv_demo",
  });
  getStoredTokensMock.mockReturnValue(undefined);
  getInitializationInfoMock.mockResolvedValue({
    success: true,
    initInfo: null,
  });
  mockUseDbUserReady.mockReturnValue(true);
});

describe("useServerState mcpProtocolVersion re-validation", () => {
  it("does not re-test a connected server on initial mount", async () => {
    const dispatch = vi.fn();
    renderRevalidationHook(dispatch, {
      profile: { mcpProtocolVersion: "2026-07-28" },
      hostConfig: buildHostConfig(),
    });

    await flushAsyncWork(10);
    expect(reconnectServerMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONNECT_FAILURE" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONNECT_SUCCESS" }),
    );
  });

  it("dispatches CONNECT_FAILURE when host pin changes and the server can't speak it", async () => {
    reconnectServerMock.mockResolvedValue({
      success: false,
      error: "-32004 UnsupportedProtocolVersionError",
    });

    const dispatch = vi.fn();
    const { rerender } = renderRevalidationHook(dispatch, {
      profile: undefined,
      hostConfig: buildHostConfig(),
    });

    await flushAsyncWork(5);
    expect(reconnectServerMock).not.toHaveBeenCalled();

    rerender({
      profile: { mcpProtocolVersion: "2026-07-28" },
      hostConfig: buildHostConfig(),
    });

    await waitFor(() => {
      expect(reconnectServerMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_FAILURE",
          name: "demo-server",
          error: expect.stringContaining("UnsupportedProtocolVersionError"),
        }),
      );
    });
  });

  it("dispatches CONNECT_SUCCESS when the server speaks the new pin", async () => {
    reconnectServerMock.mockResolvedValue({
      success: true,
      initInfo: { serverCapabilities: {} },
    });

    const dispatch = vi.fn();
    const { rerender } = renderRevalidationHook(dispatch, {
      profile: undefined,
      hostConfig: buildHostConfig(),
    });

    await flushAsyncWork(5);

    rerender({
      profile: { mcpProtocolVersion: "2026-07-28" },
      hostConfig: buildHostConfig(),
    });

    await waitFor(() => {
      expect(reconnectServerMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_SUCCESS",
          name: "demo-server",
        }),
      );
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONNECT_FAILURE" }),
    );
  });

  it("re-tests when a per-server override moves while the host default stays", async () => {
    reconnectServerMock.mockResolvedValue({ success: true, initInfo: null });

    const dispatch = vi.fn();
    const { rerender } = renderRevalidationHook(dispatch, {
      profile: undefined,
      hostConfig: buildHostConfig({
        srv_demo: { mcpProtocolVersionOverride: undefined },
      }),
    });

    await flushAsyncWork(5);
    expect(reconnectServerMock).not.toHaveBeenCalled();

    rerender({
      profile: undefined,
      hostConfig: buildHostConfig({
        srv_demo: { mcpProtocolVersionOverride: "2026-07-28" },
      }),
    });

    await waitFor(() => {
      expect(reconnectServerMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips re-test when the resolved version did not change", async () => {
    const dispatch = vi.fn();
    const { rerender } = renderRevalidationHook(dispatch, {
      profile: { mcpProtocolVersion: "2026-07-28" },
      hostConfig: buildHostConfig(),
    });

    await flushAsyncWork(5);

    rerender({
      profile: { mcpProtocolVersion: "2026-07-28" },
      hostConfig: buildHostConfig(),
    });

    await flushAsyncWork(10);
    expect(reconnectServerMock).not.toHaveBeenCalled();
  });

  it("ignores typo'd / unknown protocol version strings (treats as undefined)", async () => {
    const dispatch = vi.fn();
    const { rerender } = renderRevalidationHook(dispatch, {
      profile: undefined,
      hostConfig: buildHostConfig(),
    });

    await flushAsyncWork(5);

    rerender({
      profile: { mcpProtocolVersion: "BOGUS-VERSION" },
      hostConfig: buildHostConfig(),
    });

    await flushAsyncWork(10);
    expect(reconnectServerMock).not.toHaveBeenCalled();
  });

});
