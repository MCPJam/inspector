/**
 * Startup status sync: after a page reload the local server still holds its
 * connections, but the browser has lost each server's handshake details. The
 * sync must look those details up again, or a connected card shows no version
 * and an empty Overview. Runs the real reducer so the assertions read the
 * same state the server card renders.
 */
import { useReducer } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type {
  AppState,
  InitializationInfo,
  ServerWithName,
} from "@/state/app-types";
import { appReducer } from "@/state/app-reducer";
import { useServerState } from "../use-server-state";

const { listServersMock, getInitializationInfoMock } = vi.hoisted(() => ({
  listServersMock: vi.fn(),
  getInitializationInfoMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("@/state/mcp-api", () => ({
  testConnection: vi.fn(),
  deleteServer: vi.fn(),
  listServers: listServersMock,
  reconnectServer: vi.fn(),
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
    getStoredTokens: vi.fn(),
    clearOAuthData: vi.fn(),
    initiateOAuth: vi.fn(),
    readStoredOAuthConfig: vi.fn(),
  };
});

vi.mock("@/lib/apis/web/context", () => ({
  injectHostedServerMapping: vi.fn(),
  tryGetHostedServerDisplayName: vi.fn(),
  tryResolveProjectServer: vi.fn(() => null),
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

const CONFIG: MCPServerConfig = { url: "https://example.com/mcp" };

function savedServer(
  name: string,
  patch: Partial<ServerWithName> = {}
): ServerWithName {
  return {
    name,
    config: CONFIG,
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    retryCount: 0,
    enabled: true,
    ...patch,
  };
}

function initInfoFor(version: string): InitializationInfo {
  return {
    protocolVersion: "2026-07-28",
    transport: "streamable-http",
    serverVersion: { name: "CTRL MCP Server", version },
  };
}

function buildState(
  projectServers: string[],
  runtimeServers: Record<string, ServerWithName>
): AppState {
  return {
    projects: {
      default: {
        id: "default",
        name: "Default",
        servers: Object.fromEntries(
          projectServers.map((name) => [name, savedServer(name)])
        ),
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: true,
      },
    },
    activeProjectId: "default",
    servers: runtimeServers,
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

function renderWithReducer(initialState: AppState) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return renderHook(() => {
    const [appState, dispatch] = useReducer(appReducer, initialState);
    useServerState({
      appState,
      dispatch,
      isLoading: false,
      isAuthenticated: false,
      hasSignedInUser: false,
      currentUserId: null,
      isAuthLoading: false,
      isLoadingProjects: false,
      useLocalFallback: true,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: appState.activeProjectId,
      activeProjectServersFlat: undefined,
      activeMcpProfile: undefined,
      activeHostConfig: undefined,
      logger,
    });
    return appState;
  });
}

beforeEach(() => {
  listServersMock.mockReset();
  getInitializationInfoMock.mockReset();
});

describe("useServerState startup status sync", () => {
  it("restores the version and Overview details of every server still connected after a reload", async () => {
    listServersMock.mockResolvedValue({
      success: true,
      servers: [
        { id: "CTRL SimNext", status: "connected", config: CONFIG },
        { id: "CTRL UAT", status: "connected", config: CONFIG },
      ],
    });
    getInitializationInfoMock.mockImplementation(async (name: string) => ({
      success: true,
      initInfo: initInfoFor(name === "CTRL UAT" ? "4.1.2" : "1.7.0"),
    }));

    const { result } = renderWithReducer(
      buildState(["CTRL SimNext", "CTRL UAT"], {})
    );

    await waitFor(() => {
      expect(
        result.current.servers["CTRL SimNext"]?.initializationInfo
          ?.serverVersion?.version
      ).toBe("1.7.0");
      expect(
        result.current.servers["CTRL UAT"]?.initializationInfo?.serverVersion
          ?.version
      ).toBe("4.1.2");
    });
    expect(result.current.servers["CTRL SimNext"]?.connectionStatus).toBe(
      "connected"
    );
  });

  it("looks up only connected servers that have no details and are not mid-connect", async () => {
    const existingInfo = initInfoFor("2.0.0");
    listServersMock.mockResolvedValue({
      success: true,
      servers: [
        { id: "has-details", status: "connected", config: CONFIG },
        { id: "connecting", status: "connected", config: CONFIG },
        { id: "gone", status: "disconnected", config: CONFIG },
        { id: "missing", status: "connected", config: CONFIG },
      ],
    });
    getInitializationInfoMock.mockResolvedValue({
      success: true,
      initInfo: initInfoFor("1.0.0"),
    });

    const { result } = renderWithReducer(
      buildState([], {
        "has-details": savedServer("has-details", {
          connectionStatus: "connected",
          initializationInfo: existingInfo,
        }),
        connecting: savedServer("connecting", {
          connectionStatus: "connecting",
        }),
      })
    );

    await waitFor(() => {
      expect(
        result.current.servers.missing?.initializationInfo?.serverVersion
          ?.version
      ).toBe("1.0.0");
    });
    expect(getInitializationInfoMock.mock.calls).toEqual([["missing"]]);
    expect(result.current.servers["has-details"]?.initializationInfo).toBe(
      existingInfo
    );
  });
});
