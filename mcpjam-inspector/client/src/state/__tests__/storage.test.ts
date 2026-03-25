import { beforeEach, describe, expect, it } from "vitest";
import type { AppState, Workspace } from "../app-types";
import { loadAppState, saveAppState } from "../storage";

const STORAGE_KEY = "mcp-inspector-state";
const WORKSPACES_STORAGE_KEY = "mcp-inspector-workspaces";

function createWorkspace(): Workspace {
  return {
    id: "default",
    name: "Default",
    servers: {},
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    isDefault: true,
  };
}

describe("storage runtime server filtering", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("excludes learning runtime servers when saving app state", () => {
    const workspace = createWorkspace();
    const state: AppState = {
      servers: {
        workspace: {
          name: "workspace",
          config: { url: new URL("https://example.com/workspace") } as any,
          connectionStatus: "connected",
          lastConnectionTime: new Date("2024-01-01T00:00:00.000Z"),
          retryCount: 0,
          enabled: true,
          surface: "workspace",
        },
        __learning__: {
          name: "__learning__",
          config: { url: new URL("https://learn.mcpjam.com/mcp") } as any,
          connectionStatus: "connected",
          lastConnectionTime: new Date("2024-01-01T00:00:00.000Z"),
          retryCount: 0,
          enabled: true,
          surface: "learning",
        },
      },
      selectedServer: "workspace",
      selectedMultipleServers: [],
      isMultiSelectMode: false,
      workspaces: {
        default: {
          ...workspace,
          servers: {
            workspace: {
              name: "workspace",
              config: { url: new URL("https://example.com/workspace") } as any,
              connectionStatus: "connected",
              lastConnectionTime: new Date("2024-01-01T00:00:00.000Z"),
              retryCount: 0,
              enabled: true,
              surface: "workspace",
            },
            __learning__: {
              name: "__learning__",
              config: { url: new URL("https://learn.mcpjam.com/mcp") } as any,
              connectionStatus: "connected",
              lastConnectionTime: new Date("2024-01-01T00:00:00.000Z"),
              retryCount: 0,
              enabled: true,
              surface: "learning",
            },
          },
        },
      },
      activeWorkspaceId: "default",
    };

    saveAppState(state);

    const savedRuntime = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const savedWorkspaces = JSON.parse(
      localStorage.getItem(WORKSPACES_STORAGE_KEY) || "{}",
    );

    expect(savedRuntime.servers.workspace).toBeDefined();
    expect(savedRuntime.servers.__learning__).toBeUndefined();
    expect(savedWorkspaces.workspaces.default.servers.workspace).toBeDefined();
    expect(
      savedWorkspaces.workspaces.default.servers.__learning__,
    ).toBeUndefined();
  });

  it("filters persisted learning servers out while hydrating", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selectedServer: "__learning__",
        selectedMultipleServers: ["workspace", "__learning__"],
        isMultiSelectMode: false,
        servers: {
          workspace: {
            name: "workspace",
            config: { url: "https://example.com/workspace" },
            connectionStatus: "connected",
            retryCount: 0,
            enabled: true,
            surface: "workspace",
          },
          __learning__: {
            name: "__learning__",
            config: { url: "https://learn.mcpjam.com/mcp" },
            connectionStatus: "connected",
            retryCount: 0,
            enabled: true,
            surface: "learning",
          },
        },
      }),
    );
    localStorage.setItem(
      WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        activeWorkspaceId: "default",
        workspaces: {
          default: {
            ...createWorkspace(),
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            servers: {
              workspace: {
                name: "workspace",
                config: { url: "https://example.com/workspace" },
                connectionStatus: "connected",
                retryCount: 0,
                enabled: true,
                surface: "workspace",
              },
              __learning__: {
                name: "__learning__",
                config: { url: "https://learn.mcpjam.com/mcp" },
                connectionStatus: "connected",
                retryCount: 0,
                enabled: true,
                surface: "learning",
              },
            },
          },
        },
      }),
    );

    const result = loadAppState();

    expect(result.servers.__learning__).toBeUndefined();
    expect(result.workspaces.default.servers.__learning__).toBeUndefined();
    expect(result.selectedServer).toBe("none");
    expect(result.selectedMultipleServers).toEqual(["workspace"]);
  });
});
