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
  posthogCaptureMock,
} = vi.hoisted(() => ({
  reconnectServerMock: vi.fn(),
  tryResolveProjectServerMock: vi.fn<
    (serverNameOrId: string) => { projectId: string; serverId: string } | null
  >(() => null),
  getStoredTokensMock: vi.fn(),
  getInitializationInfoMock: vi.fn(),
  mockUseDbUserReady: vi.fn(() => true),
  posthogCaptureMock: vi.fn(),
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

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: posthogCaptureMock }),
  // `useStatelessMcpEnabled` reads this flag. Default off so the legacy
  // (pre-Auto) expectations in this suite stay exact; Auto-default cases
  // override via `statelessMcpEnabledMock`.
  useFeatureFlagEnabled: () => statelessMcpEnabledMock(),
}));

const statelessMcpEnabledMock = vi.fn(() => false);

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
  initial: { profile: Profile; hostConfig: any }
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
    })
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
  posthogCaptureMock.mockReset();
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
      expect.objectContaining({ type: "CONNECT_FAILURE" })
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONNECT_SUCCESS" })
    );
  });

  it("re-seeds without probing when the stateless flag hydrates false\u2192true", async () => {
    // PostHog's flag starts undefined/false and can flip to true shortly
    // after mount. That re-normalizes every unpinned server's effective pin
    // (undefined \u2192 "auto") but does not invalidate existing connections \u2014
    // an Auto connect lands on the same legacy path. A reconnect storm here
    // was the CodeRabbit "Major" finding on the PR.
    statelessMcpEnabledMock.mockReturnValue(false);
    const dispatch = vi.fn();
    const { rerender } = renderRevalidationHook(dispatch, {
      profile: undefined,
      hostConfig: buildHostConfig(),
    });
    await flushAsyncWork(5);
    expect(reconnectServerMock).not.toHaveBeenCalled();

    statelessMcpEnabledMock.mockReturnValue(true);
    rerender({ profile: undefined, hostConfig: buildHostConfig() });

    await flushAsyncWork(10);
    expect(reconnectServerMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONNECT_FAILURE" })
    );

    // A genuine pin edit after the flip still probes.
    reconnectServerMock.mockResolvedValue({ success: true, initInfo: null });
    rerender({
      profile: { mcpProtocolVersion: "2026-07-28" },
      hostConfig: buildHostConfig(),
    });
    await waitFor(() => {
      expect(reconnectServerMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips probing servers the project resolver can't map (no spurious CONNECT_FAILURE)", async () => {
    // `guardedReconnectServer` throws PROJECT_NOT_PROVISIONED for servers
    // `tryResolveProjectServer` can't resolve (local / not-yet-synced);
    // routing a healthy connection through it on a pin change would flip
    // the toggle to failed. The cubic P1 finding on the PR.
    tryResolveProjectServerMock.mockReturnValue(null);
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

    await flushAsyncWork(10);
    expect(reconnectServerMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONNECT_FAILURE" })
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
        })
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
        })
      );
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONNECT_FAILURE" })
    );
  });

  it("captures stateless protocol connect metadata after a successful reconnect", async () => {
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
      expect(posthogCaptureMock).toHaveBeenCalledWith(
        "stateless_protocol_connect",
        expect.objectContaining({
          mcp_protocol_version: "2026-07-28",
          protocol_pin_source: "host_default",
          connection_transport: "http",
          auth_mode: "none",
          hosted_mode: false,
          has_project_context: true,
          has_host_config: true,
          has_mcp_profile: true,
          has_timeout_ms: true,
          connection_defaults_header_count: 0,
          client_capability_count: 0,
          has_client_info: false,
          supported_protocol_version_count: 0,
          reconnect_attempt: "protocol_revalidation",
          reconnect_attempt_index: 1,
          reconnect_select: true,
          reconnect_suppressed_errors: false,
          allow_interactive_oauth_flow: false,
          had_synced_oauth_retry: false,
        })
      );
    });

    expect(posthogCaptureMock.mock.calls[0]?.[1]).not.toHaveProperty(
      "serverName"
    );
    expect(posthogCaptureMock.mock.calls[0]?.[1]).not.toHaveProperty("url");
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
