import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useEvalTraceToolContext } from "../use-eval-trace-tool-context";

const mockState = vi.hoisted(() => ({
  hostedMode: false,
  convexAuth: {
    isAuthenticated: false,
    isLoading: false,
  },
  workspaceServers: {
    serversByName: new Map<string, string>(),
    isLoading: false,
  },
  appState: {
    activeWorkspaceId: "workspace-1",
    workspaces: {
      "workspace-1": {
        id: "workspace-1",
        name: "Workspace",
        sharedWorkspaceId: "shared-workspace-1",
        servers: {},
      },
    },
    servers: {
      alpha: {
        oauthTokens: {
          access_token: "oauth-alpha",
        },
      },
    },
  },
  clientConfigStore: {
    isAwaitingRemoteEcho: false,
    pendingWorkspaceId: null,
  },
  listTools: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return mockState.hostedMode;
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
}));

vi.mock("@/hooks/useViews", () => ({
  useWorkspaceServers: () => mockState.workspaceServers,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => mockState.appState,
}));

vi.mock("@/stores/client-config-store", () => ({
  useClientConfigStore: (selector: (state: any) => unknown) =>
    selector(mockState.clientConfigStore),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (args: unknown) => mockState.listTools(args),
}));

describe("useEvalTraceToolContext", () => {
  beforeEach(() => {
    mockState.hostedMode = false;
    mockState.convexAuth.isAuthenticated = false;
    mockState.convexAuth.isLoading = false;
    mockState.workspaceServers = {
      serversByName: new Map(),
      isLoading: false,
    };
    mockState.clientConfigStore = {
      isAwaitingRemoteEcho: false,
      pendingWorkspaceId: null,
    };
    mockState.listTools.mockReset();
  });

  it("fetches tool context eagerly in local mode", async () => {
    mockState.listTools.mockResolvedValue({
      tools: [{ name: "create_view" }],
      toolsMetadata: {
        create_view: {
          ui: { resourceUri: "ui://widget/create-view.html" },
        },
      },
    });

    const { result } = renderHook(() =>
      useEvalTraceToolContext({
        serverNames: ["alpha"],
      }),
    );

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    expect(mockState.listTools).toHaveBeenCalledWith({ serverId: "alpha" });
    expect(result.current.serializedTools).toEqual({
      create_view: {
        name: "create_view",
        description: undefined,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    });
    expect(result.current.toolServerMap).toEqual({ create_view: "alpha" });
    expect(result.current.connectedServerIds).toContain("alpha");
  });

  it("waits for hosted auth and server mappings before fetching", async () => {
    mockState.hostedMode = true;
    mockState.convexAuth.isAuthenticated = false;
    mockState.convexAuth.isLoading = true;
    mockState.workspaceServers = {
      serversByName: new Map(),
      isLoading: true,
    };
    mockState.listTools.mockResolvedValue({
      tools: [{ name: "create_view" }],
      toolsMetadata: {
        create_view: {
          ui: { resourceUri: "ui://widget/create-view.html" },
        },
      },
    });

    const { result, rerender } = renderHook(
      ({ retryKey }) =>
        useEvalTraceToolContext({
          serverNames: ["alpha"],
          workspaceId: "shared-workspace-1",
          retryKey,
        }),
      {
        initialProps: { retryKey: 0 },
      },
    );

    expect(result.current.isLoading).toBe(true);
    expect(mockState.listTools).not.toHaveBeenCalled();

    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
    mockState.workspaceServers = {
      serversByName: new Map([["alpha", "server-alpha"]]),
      isLoading: false,
    };
    rerender({ retryKey: 1 });

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    expect(mockState.listTools).toHaveBeenCalledWith({ serverId: "alpha" });
    expect(result.current.toolServerMap).toEqual({
      create_view: "server-alpha",
    });
    expect(result.current.connectedServerIds).toEqual(
      expect.arrayContaining(["alpha", "server-alpha"]),
    );
    expect(result.current.hostedSelectedServerIds).toEqual(["server-alpha"]);
    expect(result.current.hostedOAuthTokens).toEqual({
      "server-alpha": "oauth-alpha",
    });
  });

  it("treats hosted readiness errors as transient and retries on the next trigger", async () => {
    mockState.hostedMode = true;
    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
    mockState.workspaceServers = {
      serversByName: new Map([["alpha", "server-alpha"]]),
      isLoading: false,
    };
    mockState.listTools
      .mockRejectedValueOnce(new Error('Hosted server not found for "alpha"'))
      .mockResolvedValueOnce({
        tools: [{ name: "create_view" }],
        toolsMetadata: {
          create_view: {
            ui: { resourceUri: "ui://widget/create-view.html" },
          },
        },
      });

    const { result, rerender } = renderHook(
      ({ retryKey }) =>
        useEvalTraceToolContext({
          serverNames: ["alpha"],
          workspaceId: "shared-workspace-1",
          retryKey,
        }),
      {
        initialProps: { retryKey: 0 },
      },
    );

    await waitFor(() => {
      expect(mockState.listTools).toHaveBeenCalledTimes(1);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    rerender({ retryKey: 1 });

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    expect(mockState.listTools).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });
});
