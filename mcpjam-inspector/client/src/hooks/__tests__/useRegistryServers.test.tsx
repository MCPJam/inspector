import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRegistryServerName,
  type RegistryServer,
  useRegistryServers,
} from "../useRegistryServers";

const {
  mockUseQuery,
  mockConnectMutation,
  mockDisconnectMutation,
} = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockConnectMutation: vi.fn(),
  mockDisconnectMutation: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (name: string) => {
    if (name === "registryServers:connectRegistryServer") {
      return mockConnectMutation;
    }
    if (name === "registryServers:disconnectRegistryServer") {
      return mockDisconnectMutation;
    }
    return vi.fn();
  },
}));

function createRegistryServer(
  overrides: Partial<RegistryServer> = {},
): RegistryServer {
  return {
    _id: "server-1",
    name: "com.test.asana",
    displayName: "Asana",
    description: "Asana MCP server",
    publisher: "MCPJam",
    category: "Productivity",
    clientType: "app",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.asana.test",
      useOAuth: true,
    },
    status: "approved",
    createdBy: "user-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("useRegistryServers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "registryServers:listRegistryServers") {
        return [createRegistryServer()];
      }
      if (name === "registryServers:getWorkspaceRegistryConnections") {
        return [];
      }
      return undefined;
    });
  });

  it("disconnects app variants using the runtime server name", async () => {
    const onDisconnect = vi.fn();
    const server = createRegistryServer({ clientType: "app" });

    const { result } = renderHook(() =>
      useRegistryServers({
        workspaceId: "workspace-1",
        isAuthenticated: true,
        liveServers: {
          [getRegistryServerName(server)]: {
            connectionStatus: "connected",
          },
        },
        onConnect: vi.fn(),
        onDisconnect,
      }),
    );

    await act(async () => {
      await result.current.disconnect(server);
    });

    expect(onDisconnect).toHaveBeenCalledWith("Asana (App)");
    expect(mockDisconnectMutation).toHaveBeenCalledWith({
      registryServerId: "server-1",
      workspaceId: "workspace-1",
    });
  });

  it("still disconnects locally when the workspace connection is already missing", async () => {
    const onDisconnect = vi.fn();
    const server = createRegistryServer({ clientType: "app" });
    mockDisconnectMutation.mockRejectedValueOnce(
      new Error("Registry server is not connected to this workspace"),
    );

    const { result } = renderHook(() =>
      useRegistryServers({
        workspaceId: "workspace-1",
        isAuthenticated: true,
        liveServers: {
          [getRegistryServerName(server)]: {
            connectionStatus: "connected",
          },
        },
        onConnect: vi.fn(),
        onDisconnect,
      }),
    );

    await act(async () => {
      await expect(result.current.disconnect(server)).resolves.toBeUndefined();
    });

    expect(onDisconnect).toHaveBeenCalledWith("Asana (App)");
  });

  it("does not create a duplicate workspace connection for an already connected registry server", async () => {
    const server = createRegistryServer({ clientType: "app" });

    mockUseQuery.mockImplementation((name: string) => {
      if (name === "registryServers:listRegistryServers") {
        return [server];
      }
      if (name === "registryServers:getWorkspaceRegistryConnections") {
        return [
          {
            _id: "connection-1",
            registryServerId: server._id,
            workspaceId: "workspace-1",
            serverId: "runtime-server-1",
            connectedBy: "user-1",
            connectedAt: Date.now(),
          },
        ];
      }
      return undefined;
    });

    const onConnect = vi.fn();
    const { result } = renderHook(() =>
      useRegistryServers({
        workspaceId: "workspace-1",
        isAuthenticated: true,
        liveServers: {
          [getRegistryServerName(server)]: {
            connectionStatus: "connected",
          },
        },
        onConnect,
      }),
    );

    await act(async () => {
      await result.current.connect(server);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onConnect).toHaveBeenCalledWith({
      name: "Asana (App)",
      type: "http",
      url: "https://mcp.asana.test",
      useOAuth: true,
      oauthScopes: undefined,
      oauthCredentialKey: undefined,
      clientId: undefined,
      registryServerId: "server-1",
    });
    expect(mockConnectMutation).not.toHaveBeenCalled();
  });
});
