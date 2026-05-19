import { act, renderHook, waitFor } from "@testing-library/react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AppAction, ServerWithName } from "@/state/app-types";
import {
  buildElectronMcpCallbackUrl,
  shouldRetryOAuthConnectionFailure,
  useServerState,
} from "../use-server-state";
import {
  CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
  PROJECT_NOT_PROVISIONED_ERROR_MESSAGE,
} from "@/lib/client-config";
import type { ProjectClientConfig } from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/client-context-store";

const {
  toastError,
  toastSuccess,
  completeHostedOAuthCallbackMock,
  handleOAuthCallbackMock,
  initiateOAuthMock,
  getStoredTokensMock,
  clearOAuthDataMock,
  readStoredOAuthConfigMock,
  testConnectionMock,
  reconnectServerMock,
  getInitializationInfoMock,
  tryResolveProjectServerMock,
  mockConvexQuery,
  mockCreateServer,
  mockCreateServerIfMissing,
  mockCreateServerWithClientSecret,
  mockUpdateServer,
  mockUpdateServerWithClientSecret,
} = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  completeHostedOAuthCallbackMock: vi.fn(),
  handleOAuthCallbackMock: vi.fn(),
  initiateOAuthMock: vi.fn(),
  getStoredTokensMock: vi.fn(),
  clearOAuthDataMock: vi.fn(),
  readStoredOAuthConfigMock: vi.fn(),
  testConnectionMock: vi.fn(),
  reconnectServerMock: vi.fn(),
  getInitializationInfoMock: vi.fn(),
  tryResolveProjectServerMock: vi.fn<
    (serverNameOrId: string) => { projectId: string; serverId: string } | null
  >(() => null),
  mockConvexQuery: vi.fn(),
  mockCreateServer: vi.fn(),
  mockCreateServerIfMissing: vi.fn(),
  mockCreateServerWithClientSecret: vi.fn(),
  mockUpdateServer: vi.fn(),
  mockUpdateServerWithClientSecret: vi.fn(),
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
    completeHostedOAuthCallback: completeHostedOAuthCallbackMock,
    handleOAuthCallback: handleOAuthCallbackMock,
    getStoredTokens: getStoredTokensMock,
    clearOAuthData: clearOAuthDataMock,
    initiateOAuth: initiateOAuthMock,
    readStoredOAuthConfig: readStoredOAuthConfigMock,
  };
});

vi.mock("@/lib/apis/web/context", () => ({
  injectHostedServerMapping: vi.fn(),
  tryGetHostedServerDisplayName: vi.fn(),
  tryResolveProjectServer: tryResolveProjectServerMock,
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

vi.mock("../useProjects", () => ({
  useServerMutations: () => ({
    createServer: mockCreateServer,
    createServerIfMissing: mockCreateServerIfMissing,
    updateServer: mockUpdateServer,
    deleteServer: vi.fn(),
    createServerWithClientSecret: mockCreateServerWithClientSecret,
    updateServerWithClientSecret: mockUpdateServerWithClientSecret,
  }),
}));

function createAppState(options?: {
  projectClientConfig?: ProjectClientConfig;
  serverCapabilities?: Record<string, unknown>;
}): AppState {
  return {
    projects: {
      default: {
        id: "default",
        name: "Default",
        clientConfig: options?.projectClientConfig,
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
    activeProjectId: "default",
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
    hasSignedInUser?: boolean;
    isAuthenticated?: boolean;
    useLocalFallback?: boolean;
    effectiveProjects?: AppState["projects"];
    effectiveActiveProjectId?: string;
    activeProjectServersFlat?: any;
  }
) {
  return renderHook(() =>
    useServerState({
      appState,
      dispatch,
      isLoading: false,
      isAuthenticated: options?.isAuthenticated ?? false,
      hasSignedInUser: options?.hasSignedInUser ?? false,
      isAuthLoading: false,
      isLoadingProjects: false,
      useLocalFallback: options?.useLocalFallback ?? true,
      effectiveProjects: options?.effectiveProjects ?? appState.projects,
      effectiveActiveProjectId:
        options?.effectiveActiveProjectId ?? appState.activeProjectId,
      activeProjectServersFlat: options?.activeProjectServersFlat,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    })
  );
}

async function flushAsyncWork(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  tryResolveProjectServerMock.mockReturnValue({
    projectId: "project_default",
    serverId: "srv_demo",
  });
  reconnectServerMock.mockReset();
  getInitializationInfoMock.mockResolvedValue({
    success: true,
    initInfo: null,
  });
});

describe("useServerState effective server projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("surfaces connected or connecting runtime-only servers", () => {
    const appState = createAppState();
    const persistedServer: ServerWithName = {
      name: "persisted-server",
      config: {
        type: "http",
        url: "https://persisted.example.com/mcp",
      } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    };
    const runtimeConnected: ServerWithName = {
      name: "runtime-connected",
      config: {
        type: "http",
        url: "https://runtime-connected.example.com/mcp",
      } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "connected",
      retryCount: 0,
      enabled: true,
    };
    const runtimeConnecting: ServerWithName = {
      name: "runtime-connecting",
      config: {
        type: "http",
        url: "https://runtime-connecting.example.com/mcp",
      } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "connecting",
      retryCount: 0,
      enabled: true,
    };
    const runtimeFailed: ServerWithName = {
      name: "runtime-failed",
      config: {
        type: "http",
        url: "https://runtime-failed.example.com/mcp",
      } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "failed",
      retryCount: 0,
      enabled: true,
    };

    appState.projects.default.servers = {
      "persisted-server": persistedServer,
    };
    appState.servers = {
      "runtime-connected": runtimeConnected,
      "runtime-connecting": runtimeConnecting,
      "runtime-failed": runtimeFailed,
    };
    appState.selectedServer = "runtime-connected";

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);

    expect(result.current.projectServers).toEqual(
      expect.objectContaining({
        "persisted-server": expect.any(Object),
        "runtime-connected": runtimeConnected,
        "runtime-connecting": runtimeConnecting,
      })
    );
    expect(result.current.projectServers).not.toHaveProperty("runtime-failed");
    expect(result.current.selectedMCPConfig).toBe(runtimeConnected.config);
    expect(result.current.connectedOrConnectingServerConfigs).toEqual(
      expect.objectContaining({
        "runtime-connected": runtimeConnected,
        "runtime-connecting": runtimeConnecting,
      })
    );
  });

  it("does not surface runtime-only servers for Convex-backed projects", () => {
    const appState = createAppState();
    const persistedServer: ServerWithName = {
      name: "persisted-server",
      config: {
        type: "http",
        url: "https://persisted.example.com/mcp",
      } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    };
    const runtimeConnected: ServerWithName = {
      name: "runtime-connected",
      config: {
        type: "http",
        url: "https://runtime-connected.example.com/mcp",
      } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "connected",
      retryCount: 0,
      enabled: true,
    };

    appState.projects.default.servers = {
      "persisted-server": persistedServer,
    };
    appState.servers = {
      "runtime-connected": runtimeConnected,
    };
    appState.selectedServer = "runtime-connected";

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState, {
      isAuthenticated: true,
      hasSignedInUser: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: "default",
      activeProjectServersFlat: [{ _id: "srv_1", name: "persisted-server" }],
    });

    expect(result.current.projectServers).toEqual({
      "persisted-server": expect.objectContaining({
        name: "persisted-server",
      }),
    });
    expect(result.current.projectServers).not.toHaveProperty(
      "runtime-connected",
    );
    expect(result.current.selectedMCPConfig).toBeUndefined();
  });
});

describe("useServerState OAuth callback failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    window.isElectron = false;
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      clientCapabilitiesError: null,
      connectionDefaultsError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
    getStoredTokensMock.mockReturnValue(undefined);
    testConnectionMock.mockResolvedValue({
      success: true,
      initInfo: null,
    });
    completeHostedOAuthCallbackMock.mockReset();
    completeHostedOAuthCallbackMock.mockResolvedValue({
      success: false,
      error: "Hosted OAuth callback should be mocked per test",
    });
    initiateOAuthMock.mockResolvedValue({ success: true });
    readStoredOAuthConfigMock.mockReturnValue({
      registryServerId: undefined,
      useRegistryOAuthProxy: false,
    });
    mockConvexQuery.mockResolvedValue(null);
    mockCreateServer.mockReset();
    mockCreateServerWithClientSecret.mockReset();
    mockUpdateServer.mockReset();
    mockUpdateServerWithClientSecret.mockReset();
    tryResolveProjectServerMock.mockReturnValue({
      projectId: "project_default",
      serverId: "srv_demo",
    });
  });

  it("marks the pending server as failed when authorization is denied", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?error=access_denied&error_description=User%20denied%20access"
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
      "OAuth authorization failed: access_denied: User denied access"
    );
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
    expect(window.location.pathname).toBe("/servers");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
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
      "Error completing OAuth flow: Token exchange failed"
    );
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
  });

  it("bounces browser OAuth callbacks back into Electron when the OAuth state is tagged for desktop", async () => {
    window.isElectron = false;
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?code=test-code&state=electron_mcp:test-state"
    );

    expect(buildElectronMcpCallbackUrl()).toBe(
      "mcpjam://oauth/callback?flow=mcp&code=test-code&state=electron_mcp%3Atest-state"
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
      "/oauth/callback?code=test-code&state=electron_mcp:test-state"
    );

    try {
      const dispatch = vi.fn();
      renderUseServerState(dispatch);
      await flushAsyncWork();

      expect(handleOAuthCallbackMock).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        "Not implemented: navigation to another Document"
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("completes Electron in-app fallback callbacks in the renderer", async () => {
    window.isElectron = true;
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    handleOAuthCallbackMock.mockResolvedValue({
      success: true,
      serverName: "demo-server",
      serverConfig: {
        type: "http",
        url: "https://example.com/mcp",
      },
    });
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?code=test-code&state=electron_mcp:test-state"
    );

    expect(buildElectronMcpCallbackUrl()).toBeNull();

    const dispatch = vi.fn();
    renderUseServerState(dispatch);

    await waitFor(() => {
      expect(handleOAuthCallbackMock).toHaveBeenCalledWith(
        "test-code",
        expect.objectContaining({
          onTraceUpdate: expect.any(Function),
        })
      );
    });
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(
        "OAuth connection successful! Connected to demo-server."
      );
    });

    expect(window.location.pathname).toBe("/servers");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
  });

  it("ignores regular browser OAuth callbacks that are not tagged for Electron", () => {
    window.isElectron = false;
    window.history.replaceState(
      {},
      "",
      "/oauth/callback?code=test-code&state=test-state"
    );

    expect(buildElectronMcpCallbackUrl()).toBeNull();
  });

  it("detects retryable transport errors after OAuth", () => {
    expect(
      shouldRetryOAuthConnectionFailure(
        "Streamable HTTP error: Request timed out. SSE error: SSE error: Non-200 status code (404)."
      )
    ).toBe(true);
    expect(
      shouldRetryOAuthConnectionFailure(
        "SSE error: Non-200 status code returned by server: 404"
      )
    ).toBe(true);
    expect(
      shouldRetryOAuthConnectionFailure(
        "OAuth failed with invalid_client from the authorization server"
      )
    ).toBe(false);
  });

  it("retries transient connection failures once after a successful OAuth callback", async () => {
    vi.useFakeTimers();

    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem(
      "mcp-serverUrl-demo-server",
      "https://example.com/mcp"
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

      expect(handleOAuthCallbackMock).toHaveBeenCalledWith(
        "test-code",
        expect.objectContaining({
          onTraceUpdate: expect.any(Function),
        })
      );
      expect(testConnectionMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
        await flushAsyncWork();
      });

      expect(testConnectionMock).toHaveBeenCalledTimes(2);

      expect(toastSuccess).toHaveBeenCalledWith(
        "OAuth connection successful! Connected to demo-server."
      );
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_SUCCESS",
          name: "demo-server",
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the app root after a successful browser OAuth callback", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    handleOAuthCallbackMock.mockResolvedValue({
      success: true,
      serverName: "demo-server",
      serverConfig: {
        type: "http",
        url: "https://example.com/mcp",
      },
    });
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const dispatch = vi.fn();
    renderUseServerState(dispatch);

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(
        "OAuth connection successful! Connected to demo-server."
      );
    });

    expect(window.location.pathname).toBe("/servers");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("preserves existing HTTP config when OAuth callback returns a bearer token config", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    readStoredOAuthConfigMock.mockReturnValue({
      scopes: ["files:read", "files:write"],
      registryServerId: undefined,
      useRegistryOAuthProxy: false,
    });
    handleOAuthCallbackMock.mockResolvedValue({
      success: true,
      serverName: "demo-server",
      serverConfig: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer access-token",
          },
        },
      },
    });
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const appState = createAppState();
    const existingServer = {
      ...appState.servers["demo-server"],
      config: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: new Headers({
            "X-Existing-Header": "present",
          }),
        },
        timeout: 15000,
        clientCapabilities: {
          roots: {
            listChanged: true,
          },
        },
      } as any,
      oauthFlowProfile: {
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
      },
    };
    appState.servers["demo-server"] = existingServer;
    appState.projects.default.servers["demo-server"] = existingServer;

    const dispatch = vi.fn();
    renderUseServerState(dispatch, appState);

    await waitFor(() => {
      expect(testConnectionMock).toHaveBeenCalled();
    });

    expect(testConnectionMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        url: "https://example.com/mcp",
        requestInit: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer access-token",
            "x-existing-header": "present",
          }),
        }),
        timeout: 15000,
        capabilities: {
          roots: {
            listChanged: true,
          },
        },
        clientCapabilities: {
          roots: {
            listChanged: true,
          },
        },
      })
    );

    const upsertAction = dispatch.mock.calls.find(
      ([action]) => action.type === "UPSERT_SERVER"
    )?.[0] as AppAction | undefined;
    expect(upsertAction).toMatchObject({
      type: "UPSERT_SERVER",
      name: "demo-server",
      server: {
        oauthFlowProfile: expect.objectContaining({
          scopes: "files:read,files:write",
        }),
      },
    });
  });

  it("replaces a stale stdio config when OAuth callback returns an HTTP config", async () => {
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    handleOAuthCallbackMock.mockResolvedValue({
      success: true,
      serverName: "demo-server",
      serverConfig: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer access-token",
          },
        },
      },
    });
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const appState = createAppState();
    const existingServer = {
      ...appState.servers["demo-server"],
      config: {
        command: "node",
        args: ["server.js"],
      } as any,
    };
    appState.servers["demo-server"] = existingServer;
    appState.projects.default.servers["demo-server"] = existingServer;

    const dispatch = vi.fn();
    renderUseServerState(dispatch, appState);

    await waitFor(() => {
      expect(testConnectionMock).toHaveBeenCalled();
    });

    expect(testConnectionMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        url: "https://example.com/mcp",
        requestInit: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer access-token",
          }),
        }),
      })
    );

    const connectConfig = testConnectionMock.mock.calls.at(-1)?.[0];
    expect(connectConfig).not.toHaveProperty("command");
    expect(connectConfig).not.toHaveProperty("args");
  });

  it("blocks connect while project client config sync is pending", async () => {
    useClientConfigStore.setState({
      pendingProjectId: "default",
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
      CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE
    );
    expect(
      dispatch.mock.calls.some(([action]) => action.type === "CONNECT_REQUEST")
    ).toBe(false);
  });

  it("blocks connect while the active project is still provisioning", async () => {
    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, createAppState(), {
      isAuthenticated: true,
      useLocalFallback: false,
    });

    await act(async () => {
      await result.current.handleConnect({
        name: "new-server",
        type: "http",
        url: "https://example.com/mcp",
      });
    });

    expect(toastError).toHaveBeenCalledWith(
      PROJECT_NOT_PROVISIONED_ERROR_MESSAGE
    );
    expect(testConnectionMock).not.toHaveBeenCalled();
    expect(mockCreateServer).not.toHaveBeenCalled();
    expect(
      dispatch.mock.calls.some(([action]) => action.type === "CONNECT_REQUEST")
    ).toBe(false);
  });

  it("uses the friendly provisioning message when the resolver mapping is missing", async () => {
    tryResolveProjectServerMock.mockReturnValue(null);
    const appState = createAppState();
    appState.projects.default.sharedProjectId = "project_default";

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState, {
      isAuthenticated: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
    });

    await act(async () => {
      await result.current.handleConnect({
        name: "new-server",
        type: "http",
        url: "https://example.com/mcp",
      });
    });

    expect(testConnectionMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "CONNECT_FAILURE",
      name: "new-server",
      error: PROJECT_NOT_PROVISIONED_ERROR_MESSAGE,
    });
    expect(toastError).toHaveBeenCalledWith(
      PROJECT_NOT_PROVISIONED_ERROR_MESSAGE
    );
  });

  it("applies project connection defaults on local reconnect", async () => {
    const { reconnectServer } = await import("@/state/mcp-api");
    const { ensureAuthorizedForReconnect } = await import(
      "@/state/oauth-orchestrator"
    );
    vi.mocked(reconnectServer).mockResolvedValue({
      success: true,
      initInfo: {
        clientCapabilities: {},
      },
    } as any);

    const appState = createAppState({
      projectClientConfig: {
        version: 1,
        connectionDefaults: {
          headers: {
            "X-Project-Header": "project",
          },
          requestTimeout: 30000,
        },
        clientCapabilities: {
          experimental: {
            projectProfile: {},
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
      serverConfig: appState.projects.default.servers["demo-server"].config,
      tokens: undefined,
    } as any);

    await result.current.handleReconnect("demo-server");

    await waitFor(() => {
      expect(vi.mocked(reconnectServer)).toHaveBeenCalled();
    });

    const [, effectiveConfig] = vi.mocked(reconnectServer).mock.calls[0] ?? [];
    expect(effectiveConfig).toMatchObject({
      requestInit: {
        headers: {
          "X-Project-Header": "project",
        },
      },
      timeout: 30000,
      capabilities: {
        experimental: {
          projectProfile: {},
        },
        sampling: {},
      },
      clientCapabilities: {
        experimental: {
          projectProfile: {},
        },
        sampling: {},
      },
    });
  });

  it("prefers an exact per-server clientCapabilities override over project capability merging", async () => {
    const { reconnectServer } = await import("@/state/mcp-api");
    const { ensureAuthorizedForReconnect } = await import(
      "@/state/oauth-orchestrator"
    );
    vi.mocked(reconnectServer).mockResolvedValue({
      success: true,
      initInfo: {
        clientCapabilities: {},
      },
    } as any);

    const appState = createAppState({
      projectClientConfig: {
        version: 1,
        connectionDefaults: {
          headers: {},
          requestTimeout: 10000,
        },
        clientCapabilities: {
          experimental: {
            projectProfile: {},
          },
        },
        hostContext: {},
      },
      serverCapabilities: {
        sampling: {},
      },
    });

    appState.projects.default.servers["demo-server"].config = {
      url: "https://example.com/mcp",
      capabilities: {
        sampling: {},
      },
      clientCapabilities: {
        roots: {
          listChanged: true,
        },
      },
    } as any;
    appState.servers["demo-server"].config =
      appState.projects.default.servers["demo-server"].config;

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);
    vi.mocked(ensureAuthorizedForReconnect).mockResolvedValue({
      kind: "ready",
      serverConfig: appState.projects.default.servers["demo-server"].config,
      tokens: undefined,
    } as any);

    await result.current.handleReconnect("demo-server");

    await waitFor(() => {
      expect(vi.mocked(reconnectServer)).toHaveBeenCalled();
    });

    const [, effectiveConfig] = vi.mocked(reconnectServer).mock.calls[0] ?? [];
    expect(effectiveConfig).toMatchObject({
      capabilities: {
        roots: {
          listChanged: true,
        },
      },
      clientCapabilities: {
        roots: {
          listChanged: true,
        },
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
      { registryServerId: "registry-asana" }
    );
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "Asana",
        serverUrl: "https://mcp.asana.com/v2/mcp",
        clientId: "asana-client-id",
        clientSecret: undefined,
        registryServerId: "registry-asana",
        useRegistryOAuthProxy: true,
        scopes: ["default"],
      })
    );
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

    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "Linear",
        serverUrl: "https://mcp.linear.app/mcp",
        clientId: undefined,
        clientSecret: undefined,
        registryServerId: "registry-linear",
        useRegistryOAuthProxy: false,
        scopes: ["read", "write"],
      })
    );
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
      "Network error: Failed to resolve registry OAuth config: registry lookup failed"
    );
  });

  it("keeps saved registry OAuth settings when forcing a fresh reconnect", async () => {
    localStorage.setItem(
      "mcp-oauth-config-demo-server",
      JSON.stringify({
        scopes: ["default"],
        customHeaders: { "X-MCPJam": "yes" },
        registryServerId: "registry-asana",
        useRegistryOAuthProxy: true,
        protocolVersion: "2025-11-25",
        registrationStrategy: "preregistered",
      })
    );
    readStoredOAuthConfigMock.mockReturnValueOnce({
      scopes: ["default"],
      customHeaders: { "X-MCPJam": "yes" },
      registryServerId: "registry-asana",
      useRegistryOAuthProxy: true,
      protocolVersion: "2025-11-25",
      registrationStrategy: "preregistered",
    });
    localStorage.setItem(
      "mcp-client-demo-server",
      JSON.stringify({
        client_id: "asana-client-id",
        client_secret: "asana-client-secret",
      })
    );
    clearOAuthDataMock.mockImplementationOnce((serverName: string) => {
      localStorage.removeItem(`mcp-oauth-config-${serverName}`);
      localStorage.removeItem(`mcp-client-${serverName}`);
    });
    initiateOAuthMock.mockResolvedValueOnce({ success: true });

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch);

    await act(async () => {
      await result.current.handleReconnect("demo-server", {
        forceOAuthFlow: true,
      });
    });

    expect(clearOAuthDataMock).toHaveBeenCalledWith("demo-server");
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "demo-server",
        serverUrl: "https://example.com/mcp",
        scopes: ["default"],
        customHeaders: { "X-MCPJam": "yes" },
        clientId: "asana-client-id",
        clientSecret: "asana-client-secret",
        registryServerId: "registry-asana",
        useRegistryOAuthProxy: true,
        protocolVersion: "2025-11-25",
        registrationStrategy: "preregistered",
      })
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPSERT_SERVER",
      name: "demo-server",
      server: expect.objectContaining({
        connectionStatus: "oauth-flow",
        useOAuth: true,
      }),
    });
  });

  it("prefers the current OAuth profile over stale stored config when forcing a fresh reconnect", async () => {
    readStoredOAuthConfigMock.mockReturnValueOnce({
      scopes: ["stale-scope"],
      customHeaders: { "X-Stale": "browser" },
      resourceUrl: "https://stale.example.com",
      registryServerId: "registry-asana",
      useRegistryOAuthProxy: true,
      protocolMode: "2025-03-26",
      protocolVersion: "2025-03-26",
      registrationMode: "dcr",
      registrationStrategy: "dcr",
    });
    localStorage.setItem(
      "mcp-client-demo-server",
      JSON.stringify({
        client_id: "stored-client-id",
        client_secret: "stored-client-secret",
      })
    );
    initiateOAuthMock.mockResolvedValueOnce({ success: true });

    const appState = createAppState();
    const profiledServer = {
      ...appState.servers["demo-server"],
      oauthFlowProfile: {
        serverUrl: "https://example.com/mcp",
        resourceUrl: "https://fresh.example.com",
        clientId: "fresh-client-id",
        clientSecret: "fresh-client-secret",
        scopes: "fresh profile",
        customHeaders: [{ key: "X-Fresh", value: "profile" }],
        protocolVersion: "2025-11-25",
        registrationStrategy: "preregistered",
      },
    };
    appState.servers["demo-server"] = profiledServer as any;
    appState.projects.default.servers["demo-server"] = profiledServer as any;

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);

    await act(async () => {
      await result.current.handleReconnect("demo-server", {
        forceOAuthFlow: true,
      });
    });

    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "demo-server",
        serverUrl: "https://example.com/mcp",
        scopes: ["fresh", "profile"],
        resourceUrl: "https://fresh.example.com",
        customHeaders: { "X-Fresh": "profile" },
        clientId: "fresh-client-id",
        clientSecret: "fresh-client-secret",
        registryServerId: "registry-asana",
        useRegistryOAuthProxy: true,
        protocolMode: "2025-11-25",
        protocolVersion: "2025-11-25",
        registrationMode: "preregistered",
        registrationStrategy: "preregistered",
      })
    );
  });

  it("marks reconnect failed if server cleanup fails before OAuth redirect", async () => {
    const { deleteServer } = await import("@/state/mcp-api");
    vi.mocked(deleteServer).mockRejectedValueOnce(new Error("cleanup failed"));
    readStoredOAuthConfigMock.mockReturnValueOnce({});

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch);

    await act(async () => {
      await result.current.handleReconnect("demo-server", {
        forceOAuthFlow: true,
      });
    });

    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "CONNECT_FAILURE",
      name: "demo-server",
      error: "cleanup failed",
    });
  });
});

describe("useServerState auth mode regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      clientCapabilitiesError: null,
      connectionDefaultsError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
    getStoredTokensMock.mockReturnValue(undefined);
    testConnectionMock.mockResolvedValue({
      success: true,
      initInfo: {},
    });
    initiateOAuthMock.mockResolvedValue({ success: true });
    mockConvexQuery.mockResolvedValue(null);
  });

  it("dispatches explicit non-OAuth success when updating an OAuth server to direct auth", async () => {
    const { deleteServer } = await import("@/state/mcp-api");
    vi.mocked(deleteServer).mockResolvedValue({ success: true } as any);

    const appState = createAppState();
    const oauthServer = {
      ...appState.servers["demo-server"],
      connectionStatus: "connected" as const,
      oauthTokens: {
        access_token: "expired-token",
        refresh_token: "refresh-token",
      },
      useOAuth: true,
    };
    appState.servers["demo-server"] = oauthServer as any;
    appState.projects.default.servers["demo-server"] = {
      ...oauthServer,
    } as any;

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);

    await act(async () => {
      await result.current.handleUpdate("demo-server", {
        name: "demo-server",
        type: "http",
        url: "https://example.com/mcp",
        useOAuth: false,
      });
    });

    const connectSuccessAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action): action is Extract<AppAction, { type: "CONNECT_SUCCESS" }> =>
          action.type === "CONNECT_SUCCESS"
      );

    expect(connectSuccessAction).toMatchObject({
      type: "CONNECT_SUCCESS",
      name: "demo-server",
      useOAuth: false,
    });
    expect(clearOAuthDataMock).toHaveBeenCalledWith("demo-server");
    expect(initiateOAuthMock).not.toHaveBeenCalled();
  });

  it("keeps reconnects on the direct path once a server is marked non-OAuth", async () => {
    const { reconnectServer } = await import("@/state/mcp-api");
    const { ensureAuthorizedForReconnect } = await import(
      "@/state/oauth-orchestrator"
    );
    vi.mocked(reconnectServer).mockResolvedValue({
      success: true,
      initInfo: {},
    } as any);

    const appState = createAppState();
    const directServer = {
      ...appState.servers["demo-server"],
      connectionStatus: "connected" as const,
      oauthTokens: undefined,
      useOAuth: false,
    };
    appState.servers["demo-server"] = directServer as any;
    appState.projects.default.servers["demo-server"] = {
      ...directServer,
    } as any;

    vi.mocked(ensureAuthorizedForReconnect).mockResolvedValue({
      kind: "ready",
      serverConfig: directServer.config,
      tokens: undefined,
    } as any);

    const dispatch = vi.fn();
    const { result } = renderUseServerState(dispatch, appState);

    await act(async () => {
      await result.current.handleReconnect("demo-server");
    });

    expect(vi.mocked(ensureAuthorizedForReconnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo-server",
        useOAuth: false,
      }),
      expect.any(Object)
    );

    const connectSuccessAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action): action is Extract<AppAction, { type: "CONNECT_SUCCESS" }> =>
          action.type === "CONNECT_SUCCESS"
      );

    expect(connectSuccessAction).toMatchObject({
      type: "CONNECT_SUCCESS",
      name: "demo-server",
      useOAuth: false,
      tokens: undefined,
    });
    expect(initiateOAuthMock).not.toHaveBeenCalled();
  });
});

describe("useServerState authenticated fallback persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      clientCapabilitiesError: null,
      connectionDefaultsError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
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

  it("persists saved server configs into the local project in authenticated fallback mode", async () => {
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

    const updateProjectAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action): action is Extract<AppAction, { type: "UPDATE_PROJECT" }> =>
          action.type === "UPDATE_PROJECT"
      );

    expect(updateProjectAction).toMatchObject({
      type: "UPDATE_PROJECT",
      projectId: "default",
    });
    expect(updateProjectAction?.updates.servers).toEqual(
      expect.objectContaining({
        "demo-server": expect.any(Object),
        "saved-fallback": expect.objectContaining({
          name: "saved-fallback",
        }),
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "Saved configuration for saved-fallback"
    );
  });

  it("persists renamed servers into the local project in authenticated fallback mode", async () => {
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
        true
      );
    });

    const updateProjectAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action): action is Extract<AppAction, { type: "UPDATE_PROJECT" }> =>
          action.type === "UPDATE_PROJECT"
      );

    expect(updateProjectAction).toMatchObject({
      type: "UPDATE_PROJECT",
      projectId: "default",
    });
    expect(updateProjectAction?.updates.servers["demo-server"]).toBeUndefined();
    expect(updateProjectAction?.updates.servers["renamed-server"]).toEqual(
      expect.objectContaining({
        name: "renamed-server",
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith("Server configuration updated");
  });
});

describe("useServerState OAuth callback in-flight dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      clientCapabilitiesError: null,
      connectionDefaultsError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
    // This block is not nested under "OAuth callback failures"; restore defaults
    // so readStoredOAuthConfig is not a bare vi.fn() returning undefined.
    getStoredTokensMock.mockReturnValue(undefined);
    testConnectionMock.mockResolvedValue({
      success: true,
      initInfo: null,
    });
    readStoredOAuthConfigMock.mockReturnValue({
      registryServerId: undefined,
      useRegistryOAuthProxy: false,
    });
    completeHostedOAuthCallbackMock.mockReset();
    completeHostedOAuthCallbackMock.mockResolvedValue({
      success: false,
      error: "Hosted OAuth callback should be mocked per test",
    });
    mockConvexQuery.mockResolvedValue(null);
    mockCreateServer.mockReset();
    mockUpdateServer.mockReset();
  });

  it("dispatches CONNECT_REQUEST for the pending server before token exchange completes", async () => {
    const { listServers } = await import("@/state/mcp-api");
    vi.mocked(listServers).mockResolvedValue({
      success: true,
      servers: [],
    } as any);

    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#demo-server");
    localStorage.setItem(
      "mcp-serverUrl-demo-server",
      "https://example.com/mcp"
    );

    // Slow token exchange — controllable promise so we can assert before it resolves
    let resolveTokenExchange!: (value: unknown) => void;
    handleOAuthCallbackMock.mockReturnValue(
      new Promise((resolve) => {
        resolveTokenExchange = resolve;
      })
    );

    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const dispatch = vi.fn();
    renderUseServerState(dispatch);

    // The early CONNECT_REQUEST must fire before the token exchange resolves
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_REQUEST",
          name: "demo-server",
        })
      );
    });

    // Token exchange hasn't finished yet — no CONNECT_SUCCESS dispatched
    expect(
      dispatch.mock.calls.some(([a]) => a.type === "CONNECT_SUCCESS")
    ).toBe(false);

    // Now let the token exchange complete and verify the full happy path
    resolveTokenExchange({
      success: true,
      serverName: "demo-server",
      serverConfig: { type: "http", url: "https://example.com/mcp" },
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CONNECT_SUCCESS",
          name: "demo-server",
          useOAuth: true,
        })
      );
    });
  });
});

describe("syncServerToConvex name-collision recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    mockCreateServer.mockReset();
    mockCreateServerIfMissing.mockReset();
    mockCreateServerWithClientSecret.mockReset();
    mockUpdateServer.mockReset();
    mockUpdateServerWithClientSecret.mockReset();
    mockConvexQuery.mockReset();
    getStoredTokensMock.mockReturnValue(null);
    readStoredOAuthConfigMock.mockReturnValue({});
    testConnectionMock.mockResolvedValue({ success: true, initInfo: null });
    tryResolveProjectServerMock.mockReturnValue({
      projectId: "project_default",
      serverId: "srv_demo",
    });
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      clientCapabilitiesError: null,
      connectionDefaultsError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
  });

  it("primary path: uses Convex query to recover when snapshot is still loading", async () => {
    const appState = createAppState();
    appState.projects.default.sharedProjectId = "project_default";
    const dispatch = vi.fn();

    mockConvexQuery.mockResolvedValue([
      { _id: "srv_existing", name: "Excalidraw (App)" },
    ]);
    mockUpdateServer.mockResolvedValue(undefined);

    const { result } = renderUseServerState(dispatch, appState, {
      isAuthenticated: true,
      hasSignedInUser: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      activeProjectServersFlat: undefined,
    });

    await act(async () => {
      await result.current.saveServerConfigWithoutConnecting({
        name: "Excalidraw (App)",
        type: "http",
        url: "https://mcp.excalidraw.com/mcp",
      });
    });

    expect(mockConvexQuery).toHaveBeenCalledWith("servers:getProjectServers", {
      projectId: "default",
    });
    expect(mockUpdateServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv_existing" })
    );
    expect(mockCreateServer).not.toHaveBeenCalled();
  });

  it("uses create-if-missing when a stale-loaded snapshot misses the row", async () => {
    const appState = createAppState();
    appState.projects.default.sharedProjectId = "project_default";
    const dispatch = vi.fn();

    mockCreateServerIfMissing.mockResolvedValue("srv_existing");

    const { result } = renderUseServerState(dispatch, appState, {
      isAuthenticated: true,
      hasSignedInUser: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      activeProjectServersFlat: [],
    });

    await act(async () => {
      await result.current.saveServerConfigWithoutConnecting({
        name: "Excalidraw (App)",
        type: "http",
        url: "https://mcp.excalidraw.com/mcp",
      });
    });

    expect(mockCreateServerIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default",
        name: "Excalidraw (App)",
      })
    );
    expect(mockCreateServer).not.toHaveBeenCalled();
    expect(mockConvexQuery).not.toHaveBeenCalled();
  });

  it("uses create-if-missing when the loading-window query misses the existing row", async () => {
    const appState = createAppState();
    appState.projects.default.sharedProjectId = "project_default";
    const dispatch = vi.fn();

    mockConvexQuery.mockResolvedValue([]);
    mockCreateServerIfMissing.mockResolvedValue("srv_existing");

    const { result } = renderUseServerState(dispatch, appState, {
      isAuthenticated: true,
      hasSignedInUser: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      activeProjectServersFlat: undefined,
    });

    await act(async () => {
      await result.current.saveServerConfigWithoutConnecting({
        name: "Excalidraw (App)",
        type: "http",
        url: "https://mcp.excalidraw.com/mcp",
      });
    });

    expect(mockConvexQuery).toHaveBeenCalledWith("servers:getProjectServers", {
      projectId: "default",
    });
    expect(mockCreateServerIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default",
        name: "Excalidraw (App)",
      })
    );
    expect(mockCreateServer).not.toHaveBeenCalled();
  });

  it("keeps OAuth client-secret creates on the existing secret action", async () => {
    const appState = createAppState();
    appState.projects.default.sharedProjectId = "project_default";
    const dispatch = vi.fn();

    mockConvexQuery.mockResolvedValue([]);
    mockCreateServerWithClientSecret.mockResolvedValue("srv_oauth");

    const { result } = renderUseServerState(dispatch, appState, {
      isAuthenticated: true,
      hasSignedInUser: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      activeProjectServersFlat: undefined,
    });

    await act(async () => {
      await result.current.saveServerConfigWithoutConnecting({
        name: "OAuth Server",
        type: "http",
        url: "https://oauth.example.com/mcp",
        useOAuth: true,
        clientId: "client-id",
        clientSecret: "client-secret",
      });
    });

    expect(mockCreateServerWithClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default",
        name: "OAuth Server",
        clientSecret: "client-secret",
      })
    );
    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
  });
});

describe("persistRuntimeServerToProjectIfNeeded", () => {
  function buildCloudPersistState(
    connectionStatus: ServerWithName["connectionStatus"] = "connected"
  ): AppState {
    const projects: AppState["projects"] = {
      proj_cloud: {
        id: "proj_cloud",
        name: "Cloud",
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: true,
      },
    };
    return {
      projects,
      activeProjectId: "proj_cloud",
      servers: {
        "rt-server": {
          name: "rt-server",
          config: { url: "https://runtime.example/mcp" } as any,
          lastConnectionTime: new Date(),
          connectionStatus,
          retryCount: 0,
          enabled: true,
          useOAuth: false,
        },
      },
      selectedServer: "rt-server",
      selectedMultipleServers: [],
      isMultiSelectMode: false,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateServer.mockReset();
    mockCreateServerIfMissing.mockReset();
    mockCreateServerWithClientSecret.mockReset();
    mockUpdateServer.mockReset();
    mockUpdateServerWithClientSecret.mockReset();
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      clientCapabilitiesError: null,
      connectionDefaultsError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
    mockConvexQuery.mockResolvedValue(null);
  });

  it("persists selected runtime-only connected server", async () => {
    const dispatch = vi.fn();
    const appState = buildCloudPersistState("connected");
    const flatRef: { current: { _id: string; name: string }[] | undefined } = {
      current: [],
    };

    const { result, rerender } = renderHook(() =>
      useServerState({
        appState,
        dispatch,
        isLoading: false,
        isAuthenticated: true,
        hasSignedInUser: true,
        isAuthLoading: false,
        isLoadingProjects: false,
        useLocalFallback: false,
        effectiveProjects: appState.projects,
        effectiveActiveProjectId: "proj_cloud",
        activeProjectServersFlat: flatRef.current,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      })
    );

    mockCreateServerIfMissing.mockImplementation(async () => {
      flatRef.current = [{ _id: "new_srv_id", name: "rt-server" }];
      flushSync(() => {
        rerender();
      });
      return "new_srv_id";
    });

    await act(async () => {
      const out = await result.current.persistRuntimeServerToProjectIfNeeded(
        "rt-server"
      );
      expect(out).toBe("persisted");
    });

    expect(mockCreateServerIfMissing).toHaveBeenCalledTimes(1);
    expect(mockUpdateServer).not.toHaveBeenCalled();
  });

  it("does nothing for guest-like or unsigned state", async () => {
    mockCreateServerIfMissing.mockResolvedValue("id");
    const dispatch = vi.fn();
    const appState = buildCloudPersistState();
    const { result } = renderUseServerState(dispatch, appState, {
      hasSignedInUser: false,
      isAuthenticated: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: "proj_cloud",
      activeProjectServersFlat: [],
    });

    await act(async () => {
      expect(
        await result.current.persistRuntimeServerToProjectIfNeeded("rt-server")
      ).toBe("noop");
    });

    const { result: r2 } = renderUseServerState(dispatch, appState, {
      hasSignedInUser: true,
      isAuthenticated: false,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: "proj_cloud",
      activeProjectServersFlat: [],
    });
    await act(async () => {
      expect(
        await r2.current.persistRuntimeServerToProjectIfNeeded("rt-server")
      ).toBe("noop");
    });

    const { result: r3 } = renderUseServerState(dispatch, appState, {
      hasSignedInUser: true,
      isAuthenticated: true,
      useLocalFallback: true,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: "proj_cloud",
      activeProjectServersFlat: [],
    });
    await act(async () => {
      expect(
        await r3.current.persistRuntimeServerToProjectIfNeeded("rt-server")
      ).toBe("noop");
    });

    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
  });

  it("does nothing for missing or non-connected runtime server", async () => {
    mockCreateServerIfMissing.mockResolvedValue("id");
    const dispatch = vi.fn();
    const appState = buildCloudPersistState("connecting");
    const { result } = renderUseServerState(dispatch, appState, {
      hasSignedInUser: true,
      isAuthenticated: true,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: "proj_cloud",
      activeProjectServersFlat: [],
    });

    await act(async () => {
      expect(
        await result.current.persistRuntimeServerToProjectIfNeeded("rt-server")
      ).toBe("noop");
    });

    for (const status of ["failed", "disconnected", "oauth-flow"] as const) {
      const st = buildCloudPersistState(status);
      const { result: r } = renderUseServerState(dispatch, st, {
        hasSignedInUser: true,
        isAuthenticated: true,
        useLocalFallback: false,
        effectiveProjects: st.projects,
        effectiveActiveProjectId: "proj_cloud",
        activeProjectServersFlat: [],
      });
      await act(async () => {
        expect(
          await r.current.persistRuntimeServerToProjectIfNeeded("rt-server")
        ).toBe("noop");
      });
    }

    const missing = buildCloudPersistState();
    const { result: rm } = renderUseServerState(dispatch, missing, {
      hasSignedInUser: true,
      isAuthenticated: true,
      useLocalFallback: false,
      effectiveProjects: missing.projects,
      effectiveActiveProjectId: "proj_cloud",
      activeProjectServersFlat: [],
    });
    await act(async () => {
      expect(
        await rm.current.persistRuntimeServerToProjectIfNeeded("nope")
      ).toBe("noop");
    });

    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
  });

  it("waits for project server snapshot before deciding collision", async () => {
    const dispatch = vi.fn();
    const appState = buildCloudPersistState();
    const flatRef: { current: { _id: string; name: string }[] | undefined } = {
      current: undefined,
    };

    mockCreateServerIfMissing.mockImplementation(async () => {
      flatRef.current = [{ _id: "new", name: "rt-server" }];
      flushSync(() => {
        rerender();
      });
      return "new";
    });

    const { result, rerender } = renderHook(() =>
      useServerState({
        appState,
        dispatch,
        isLoading: false,
        isAuthenticated: true,
        hasSignedInUser: true,
        isAuthLoading: false,
        isLoadingProjects: false,
        useLocalFallback: false,
        effectiveProjects: appState.projects,
        effectiveActiveProjectId: "proj_cloud",
        activeProjectServersFlat: flatRef.current,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      })
    );

    const done = act(async () => {
      await result.current.persistRuntimeServerToProjectIfNeeded("rt-server");
    });

    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();

    flatRef.current = [];
    flushSync(() => {
      rerender();
    });

    await done;

    expect(mockCreateServerIfMissing).toHaveBeenCalledTimes(1);
  });

  it("skips write when same-name saved server appears after waiting", async () => {
    const dispatch = vi.fn();
    const appState = buildCloudPersistState();
    const flatRef: { current: { _id: string; name: string }[] | undefined } = {
      current: undefined,
    };

    const { result, rerender } = renderHook(() =>
      useServerState({
        appState,
        dispatch,
        isLoading: false,
        isAuthenticated: true,
        hasSignedInUser: true,
        isAuthLoading: false,
        isLoadingProjects: false,
        useLocalFallback: false,
        effectiveProjects: appState.projects,
        effectiveActiveProjectId: "proj_cloud",
        activeProjectServersFlat: flatRef.current,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      })
    );

    const done = act(async () => {
      const out = await result.current.persistRuntimeServerToProjectIfNeeded(
        "rt-server"
      );
      expect(out).toBe("skipped_existing_name");
    });

    flatRef.current = [{ _id: "existing", name: "rt-server" }];
    flushSync(() => {
      rerender();
    });

    await done;
    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
  });

  it("clears pending key on failed mutation", async () => {
    const dispatch = vi.fn();
    const appState = buildCloudPersistState();
    const flatRef: { current: { _id: string; name: string }[] | undefined } = {
      current: [],
    };

    mockCreateServerIfMissing.mockResolvedValueOnce(undefined);

    const { result, rerender } = renderHook(() =>
      useServerState({
        appState,
        dispatch,
        isLoading: false,
        isAuthenticated: true,
        hasSignedInUser: true,
        isAuthLoading: false,
        isLoadingProjects: false,
        useLocalFallback: false,
        effectiveProjects: appState.projects,
        effectiveActiveProjectId: "proj_cloud",
        activeProjectServersFlat: flatRef.current,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      })
    );

    await act(async () => {
      expect(
        await result.current.persistRuntimeServerToProjectIfNeeded("rt-server")
      ).toBe("failed");
    });

    mockCreateServerIfMissing.mockReset();
    mockCreateServerIfMissing.mockImplementation(async () => {
      flatRef.current = [{ _id: "n2", name: "rt-server" }];
      flushSync(() => {
        rerender();
      });
      return "n2";
    });

    await act(async () => {
      expect(
        await result.current.persistRuntimeServerToProjectIfNeeded("rt-server")
      ).toBe("persisted");
    });

    expect(mockCreateServerIfMissing).toHaveBeenCalledTimes(1);
  });

  it("clears pending key when Convex echo lands", async () => {
    const dispatch = vi.fn();
    const appState = buildCloudPersistState();
    const flatRef: { current: { _id: string; name: string }[] | undefined } = {
      current: [],
    };

    const { result, rerender } = renderHook(() =>
      useServerState({
        appState,
        dispatch,
        isLoading: false,
        isAuthenticated: true,
        hasSignedInUser: true,
        isAuthLoading: false,
        isLoadingProjects: false,
        useLocalFallback: false,
        effectiveProjects: appState.projects,
        effectiveActiveProjectId: "proj_cloud",
        activeProjectServersFlat: flatRef.current,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      })
    );

    mockCreateServerIfMissing.mockImplementation(async () => {
      flatRef.current = [{ _id: "echo", name: "rt-server" }];
      flushSync(() => {
        rerender();
      });
      return "echo";
    });

    await act(async () => {
      expect(
        await result.current.persistRuntimeServerToProjectIfNeeded("rt-server")
      ).toBe("persisted");
    });

    await act(async () => {
      const followUp =
        await result.current.persistRuntimeServerToProjectIfNeeded("rt-server");
      expect(followUp).toBe("skipped_existing_name");
    });
  });

  it("dedupes repeated calls while first persist is in flight", async () => {
    const dispatch = vi.fn();
    const appState = buildCloudPersistState();
    const flatRef: { current: { _id: string; name: string }[] | undefined } = {
      current: [],
    };
    let resolveCreate!: (v: string) => void;
    mockCreateServerIfMissing.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveCreate = resolve;
        })
    );

    const { result, rerender } = renderHook(() =>
      useServerState({
        appState,
        dispatch,
        isLoading: false,
        isAuthenticated: true,
        hasSignedInUser: true,
        isAuthLoading: false,
        isLoadingProjects: false,
        useLocalFallback: false,
        effectiveProjects: appState.projects,
        effectiveActiveProjectId: "proj_cloud",
        activeProjectServersFlat: flatRef.current,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      })
    );

    const p1 = act(async () =>
      result.current.persistRuntimeServerToProjectIfNeeded("rt-server")
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      const second = await result.current.persistRuntimeServerToProjectIfNeeded(
        "rt-server"
      );
      expect(second).toBe("pending");
    });

    expect(mockCreateServerIfMissing).toHaveBeenCalledTimes(1);

    resolveCreate!("srv1");
    flatRef.current = [{ _id: "srv1", name: "rt-server" }];
    flushSync(() => {
      rerender();
    });

    await act(async () => {
      await p1;
    });
    await act(async () => {
      const again = await result.current.persistRuntimeServerToProjectIfNeeded(
        "rt-server"
      );
      expect(again).toBe("skipped_existing_name");
    });
    expect(mockCreateServerIfMissing).toHaveBeenCalledTimes(1);
  });

  it("waits for auth and project readiness before persisting", async () => {
    const dispatch = vi.fn();
    const appState = buildCloudPersistState();
    const flatRef: { current: { _id: string; name: string }[] | undefined } = {
      current: undefined,
    };

    const readiness = {
      isAuthenticated: false,
      hasSignedInUser: true,
      isAuthLoading: true,
      isLoadingProjects: true,
      useLocalFallback: false,
      effectiveActiveProjectId: "none",
    };

    const { result, rerender } = renderHook(() =>
      useServerState({
        appState,
        dispatch,
        isLoading: false,
        isAuthenticated: readiness.isAuthenticated,
        hasSignedInUser: readiness.hasSignedInUser,
        isAuthLoading: readiness.isAuthLoading,
        isLoadingProjects: readiness.isLoadingProjects,
        useLocalFallback: readiness.useLocalFallback,
        effectiveProjects: appState.projects,
        effectiveActiveProjectId: readiness.effectiveActiveProjectId,
        activeProjectServersFlat: flatRef.current,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      })
    );

    flushSync(() => {
      rerender();
    });

    mockCreateServerIfMissing.mockImplementation(async () => {
      flatRef.current = [{ _id: "late_srv", name: "rt-server" }];
      flushSync(() => {
        rerender();
      });
      return "late_srv";
    });

    const done = act(async () => {
      const out = await result.current.persistRuntimeServerToProjectIfNeeded(
        "rt-server"
      );
      expect(out).toBe("persisted");
    });

    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();

    readiness.isAuthenticated = true;
    readiness.isAuthLoading = false;
    readiness.isLoadingProjects = false;
    readiness.effectiveActiveProjectId = "proj_cloud";
    flatRef.current = [];
    flushSync(() => {
      rerender();
    });

    await done;

    expect(mockCreateServerIfMissing).toHaveBeenCalledTimes(1);
  });
});
