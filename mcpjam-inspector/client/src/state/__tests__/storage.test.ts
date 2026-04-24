import { beforeEach, describe, expect, it } from "vitest";
import type { AppState, ServerWithName, Workspace } from "../app-types";
import { loadAppState, saveAppState } from "../storage";

function createServer(
  name: string,
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name,
    config: { url: new URL("https://mcp.example.com") } as ServerWithName["config"],
    connectionStatus: "connected",
    lastConnectionTime: new Date("2026-04-10T12:00:00.000Z"),
    retryCount: 0,
    enabled: true,
    ...overrides,
  } as ServerWithName;
}

function createState(server: ServerWithName): AppState {
  const workspace: Workspace = {
    id: "default",
    name: "Default",
    servers: { [server.name]: server },
    createdAt: new Date("2026-04-10T12:00:00.000Z"),
    updatedAt: new Date("2026-04-10T12:00:00.000Z"),
    isDefault: true,
  };

  return {
    workspaces: { default: workspace },
    activeWorkspaceId: "default",
    servers: { [server.name]: server },
    selectedServer: server.name,
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

describe("storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("does not persist live oauth traces in saved app state", () => {
    const server = createServer("asana", {
      lastOAuthTrace: {
        version: 1,
        source: "interactive_connect",
        serverName: "asana",
        currentStep: "token_request",
        steps: [],
        httpHistory: [],
      },
    });

    saveAppState(createState(server));

    const persistedState = JSON.parse(
      localStorage.getItem("mcp-inspector-state") ?? "{}",
    );
    const persistedWorkspaces = JSON.parse(
      localStorage.getItem("mcp-inspector-workspaces") ?? "{}",
    );

    expect(persistedState.servers.asana.lastOAuthTrace).toBeUndefined();
    expect(
      persistedWorkspaces.workspaces.default.servers.asana.lastOAuthTrace,
    ).toBeUndefined();
  });

  it("drops persisted oauth traces on load and clears legacy trace storage", () => {
    localStorage.setItem(
      "mcp-oauth-trace-asana",
      JSON.stringify({
        version: 1,
        source: "interactive_connect",
        currentStep: "token_request",
        steps: [],
        httpHistory: [],
      }),
    );
    localStorage.setItem(
      "mcp-inspector-state",
      JSON.stringify({
        selectedServer: "asana",
        servers: {
          asana: {
            name: "asana",
            config: { url: "https://mcp.example.com" },
            connectionStatus: "connected",
            lastConnectionTime: "2026-04-10T12:00:00.000Z",
            retryCount: 0,
            enabled: true,
            lastOAuthTrace: {
              version: 1,
              source: "interactive_connect",
              currentStep: "token_request",
              steps: [],
              httpHistory: [],
            },
          },
        },
      }),
    );

    const state = loadAppState();

    expect(state.servers.asana.lastOAuthTrace).toBeUndefined();
    expect(localStorage.getItem("mcp-oauth-trace-asana")).toBeNull();
  });
});
