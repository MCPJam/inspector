import { describe, it, expect } from "vitest";
import { appReducer } from "../app-reducer.js";
import type { AppState, ServerWithName, Project } from "../app-types.js";

// Helper to create minimal valid state
function createInitialState(overrides: Partial<AppState> = {}): AppState {
  const defaultProject: Project = {
    id: "project-1",
    name: "Default Project",
    servers: {},
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    isDefault: true,
  };

  return {
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
    projects: { [defaultProject.id]: defaultProject },
    activeProjectId: defaultProject.id,
    ...overrides,
  };
}

// Helper to create a server entry
function createServer(
  name: string,
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name,
    config: { command: "node", args: ["server.js"] },
    connectionStatus: "disconnected",
    lastConnectionTime: new Date("2024-01-01"),
    retryCount: 0,
    enabled: false,
    ...overrides,
  } as ServerWithName;
}

describe("appReducer", () => {
  describe("HYDRATE_STATE", () => {
    it("replaces entire state with payload", () => {
      const initialState = createInitialState();
      const newState = createInitialState({
        selectedServer: "test-server",
        servers: { "test-server": createServer("test-server") },
      });

      const result = appReducer(initialState, {
        type: "HYDRATE_STATE",
        payload: newState,
      });

      expect(result).toEqual(newState);
      expect(result).not.toBe(initialState);
    });
  });

  describe("UPSERT_SERVER", () => {
    it("adds a new server to state", () => {
      const state = createInitialState();
      const server = createServer("new-server");

      const result = appReducer(state, {
        type: "UPSERT_SERVER",
        name: "new-server",
        server,
      });

      expect(result.servers["new-server"]).toEqual(server);
    });

    it("updates an existing server", () => {
      const existingServer = createServer("existing", { enabled: false });
      const state = createInitialState({
        servers: { existing: existingServer },
      });
      const updatedServer = createServer("existing", { enabled: true });

      const result = appReducer(state, {
        type: "UPSERT_SERVER",
        name: "existing",
        server: updatedServer,
      });

      expect(result.servers["existing"].enabled).toBe(true);
    });
  });

  describe("CONNECT_REQUEST", () => {
    it("creates new server in connecting state", () => {
      const state = createInitialState();
      const config = { command: "node", args: ["server.js"] };

      const result = appReducer(state, {
        type: "CONNECT_REQUEST",
        name: "new-server",
        config,
        select: false,
      });

      expect(result.servers["new-server"]).toBeDefined();
      expect(result.servers["new-server"].connectionStatus).toBe("connecting");
      expect(result.servers["new-server"].enabled).toBe(true);
    });

    it("updates existing server to connecting state", () => {
      const existingServer = createServer("existing", {
        connectionStatus: "disconnected",
      });
      const state = createInitialState({
        servers: { existing: existingServer },
      });

      const result = appReducer(state, {
        type: "CONNECT_REQUEST",
        name: "existing",
        config: existingServer.config,
        select: false,
      });

      expect(result.servers["existing"].connectionStatus).toBe("connecting");
      expect(result.servers["existing"].enabled).toBe(true);
    });

    it("selects server when select is true", () => {
      const state = createInitialState();

      const result = appReducer(state, {
        type: "CONNECT_REQUEST",
        name: "new-server",
        config: { command: "node" },
        select: true,
      });

      expect(result.selectedServer).toBe("new-server");
    });

    it("does not change selection when select is false", () => {
      const state = createInitialState({ selectedServer: "other-server" });

      const result = appReducer(state, {
        type: "CONNECT_REQUEST",
        name: "new-server",
        config: { command: "node" },
        select: false,
      });

      expect(result.selectedServer).toBe("other-server");
    });
  });

  describe("RECONNECT_REQUEST", () => {
    it("selects the reconnected server when select is true", () => {
      const existingServer = createServer("server-b", {
        connectionStatus: "disconnected",
      });
      const state = createInitialState({
        selectedServer: "server-a",
        servers: { "server-b": existingServer },
      });

      const result = appReducer(state, {
        type: "RECONNECT_REQUEST",
        name: "server-b",
        config: existingServer.config,
        select: true,
      });

      expect(result.selectedServer).toBe("server-b");
      expect(result.servers["server-b"].connectionStatus).toBe("connecting");
    });

    it("does not change selection when select is omitted (backwards compatible)", () => {
      const existingServer = createServer("server-b", {
        connectionStatus: "disconnected",
      });
      const state = createInitialState({
        selectedServer: "server-a",
        servers: { "server-b": existingServer },
      });

      const result = appReducer(state, {
        type: "RECONNECT_REQUEST",
        name: "server-b",
        config: existingServer.config,
      });

      expect(result.selectedServer).toBe("server-a");
      expect(result.servers["server-b"].connectionStatus).toBe("connecting");
    });
  });

  describe("CONNECT_SUCCESS", () => {
    it("updates server to connected state", () => {
      const server = createServer("test", { connectionStatus: "connecting" });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { test: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { test: server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "CONNECT_SUCCESS",
        name: "test",
        config: server.config,
      });

      expect(result.servers["test"].connectionStatus).toBe("connected");
      expect(result.servers["test"].enabled).toBe(true);
      expect(result.servers["test"].retryCount).toBe(0);
      expect(result.servers["test"].lastError).toBeUndefined();
    });

    it("stores OAuth tokens when provided", () => {
      const server = createServer("oauth-server", {
        connectionStatus: "connecting",
      });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { "oauth-server": server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { "oauth-server": server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });
      const tokens = {
        access_token: "test-token",
        refresh_token: "refresh-token",
      };

      const result = appReducer(state, {
        type: "CONNECT_SUCCESS",
        name: "oauth-server",
        config: server.config,
        tokens,
      });

      expect(result.servers["oauth-server"].oauthTokens).toEqual(tokens);
      expect(result.servers["oauth-server"].useOAuth).toBe(true);
    });

    it("preserves OAuth mode when hosted auth succeeds without browser tokens", () => {
      const server = createServer("oauth-server", {
        connectionStatus: "connecting",
        useOAuth: true,
      });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { "oauth-server": server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { "oauth-server": server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "CONNECT_SUCCESS",
        name: "oauth-server",
        config: server.config,
      });

      expect(result.servers["oauth-server"].useOAuth).toBe(true);
      expect(result.servers["oauth-server"].oauthTokens).toBeUndefined();
    });

    it("allows explicit non-OAuth success to clear stale OAuth mode", () => {
      const server = createServer("oauth-server", {
        connectionStatus: "connecting",
        useOAuth: true,
      });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { "oauth-server": server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { "oauth-server": server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "CONNECT_SUCCESS",
        name: "oauth-server",
        config: server.config,
        useOAuth: false,
      });

      expect(result.servers["oauth-server"].useOAuth).toBe(false);
      expect(result.servers["oauth-server"].oauthTokens).toBeUndefined();
    });

    it("creates server if it does not exist (Convex-synced servers)", () => {
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });
      const config = { command: "node" };

      const result = appReducer(state, {
        type: "CONNECT_SUCCESS",
        name: "new-server",
        config,
      });

      expect(result.servers["new-server"]).toBeDefined();
      expect(result.servers["new-server"].connectionStatus).toBe("connected");
    });
  });

  describe("CONNECT_FAILURE", () => {
    it("updates server to failed state with error", () => {
      const server = createServer("failing", {
        connectionStatus: "connecting",
      });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { failing: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { failing: server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "CONNECT_FAILURE",
        name: "failing",
        error: "Connection refused",
      });

      expect(result.servers["failing"].connectionStatus).toBe("failed");
      expect(result.servers["failing"].lastError).toBe("Connection refused");
    });

    it("returns unchanged state if server does not exist", () => {
      const state = createInitialState();

      const result = appReducer(state, {
        type: "CONNECT_FAILURE",
        name: "nonexistent",
        error: "Not found",
      });

      expect(result).toBe(state);
    });
  });

  describe("DISCONNECT", () => {
    it("updates server to disconnected state", () => {
      const server = createServer("connected", {
        connectionStatus: "connected",
        enabled: true,
      });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { connected: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { connected: server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "DISCONNECT",
        name: "connected",
      });

      expect(result.servers["connected"].connectionStatus).toBe("disconnected");
      expect(result.servers["connected"].enabled).toBe(false);
    });

    it("clears selection if disconnected server was selected", () => {
      const server = createServer("selected", {
        connectionStatus: "connected",
      });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { selected: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { selected: server },
        selectedServer: "selected",
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "DISCONNECT",
        name: "selected",
      });

      expect(result.selectedServer).toBe("none");
    });

    it("removes server from multi-selection", () => {
      const server = createServer("multi", { connectionStatus: "connected" });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { multi: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { multi: server },
        selectedMultipleServers: ["multi", "other"],
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "DISCONNECT",
        name: "multi",
      });

      expect(result.selectedMultipleServers).toEqual(["other"]);
    });

    it("stores error if provided", () => {
      const server = createServer("error", { connectionStatus: "connected" });
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { error: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { error: server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "DISCONNECT",
        name: "error",
        error: "Lost connection",
      });

      expect(result.servers["error"].lastError).toBe("Lost connection");
    });
  });

  describe("REMOVE_SERVER", () => {
    it("removes server from state completely", () => {
      const server = createServer("to-remove");
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { "to-remove": server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { "to-remove": server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "REMOVE_SERVER",
        name: "to-remove",
      });

      expect(result.servers["to-remove"]).toBeUndefined();
      expect(
        result.projects["project-1"].servers["to-remove"],
      ).toBeUndefined();
    });

    it("clears selection if removed server was selected", () => {
      const server = createServer("selected");
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { selected: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { selected: server },
        selectedServer: "selected",
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });

      const result = appReducer(state, {
        type: "REMOVE_SERVER",
        name: "selected",
      });

      expect(result.selectedServer).toBe("none");
    });
  });

  describe("SELECT_SERVER", () => {
    it("updates selected server", () => {
      const state = createInitialState({ selectedServer: "old" });

      const result = appReducer(state, {
        type: "SELECT_SERVER",
        name: "new",
      });

      expect(result.selectedServer).toBe("new");
    });
  });

  describe("SET_MULTI_SELECTED", () => {
    it("sets multiple selected servers", () => {
      const state = createInitialState();

      const result = appReducer(state, {
        type: "SET_MULTI_SELECTED",
        names: ["server-1", "server-2", "server-3"],
      });

      expect(result.selectedMultipleServers).toEqual([
        "server-1",
        "server-2",
        "server-3",
      ]);
    });
  });

  describe("SET_MULTI_MODE", () => {
    it("enables multi-select mode and clears selection", () => {
      const state = createInitialState({
        isMultiSelectMode: false,
        selectedMultipleServers: ["old-selection"],
      });

      const result = appReducer(state, {
        type: "SET_MULTI_MODE",
        enabled: true,
      });

      expect(result.isMultiSelectMode).toBe(true);
      expect(result.selectedMultipleServers).toEqual([]);
    });

    it("disables multi-select mode and preserves selection", () => {
      const state = createInitialState({
        isMultiSelectMode: true,
        selectedMultipleServers: ["keep-these"],
      });

      const result = appReducer(state, {
        type: "SET_MULTI_MODE",
        enabled: false,
      });

      expect(result.isMultiSelectMode).toBe(false);
      expect(result.selectedMultipleServers).toEqual(["keep-these"]);
    });
  });

  describe("SYNC_AGENT_STATUS", () => {
    it("updates server statuses from agent", () => {
      const server1 = createServer("server-1", {
        connectionStatus: "disconnected",
      });
      const server2 = createServer("server-2", {
        connectionStatus: "disconnected",
      });
      const state = createInitialState({
        servers: { "server-1": server1, "server-2": server2 },
      });

      const result = appReducer(state, {
        type: "SYNC_AGENT_STATUS",
        servers: [
          { id: "server-1", status: "connected" },
          { id: "server-2", status: "failed" },
        ],
      });

      expect(result.servers["server-1"].connectionStatus).toBe("connected");
      expect(result.servers["server-2"].connectionStatus).toBe("failed");
    });

    it("preserves connecting status (in-flight operations)", () => {
      const connecting = createServer("connecting", {
        connectionStatus: "connecting",
      });
      const state = createInitialState({
        servers: { connecting },
      });

      const result = appReducer(state, {
        type: "SYNC_AGENT_STATUS",
        servers: [{ id: "connecting", status: "disconnected" }],
      });

      expect(result.servers["connecting"].connectionStatus).toBe("connecting");
    });

    it("sets disconnected for servers not in agent list", () => {
      const orphan = createServer("orphan", { connectionStatus: "connected" });
      const state = createInitialState({
        servers: { orphan },
      });

      const result = appReducer(state, {
        type: "SYNC_AGENT_STATUS",
        servers: [], // Empty - no servers reported by agent
      });

      expect(result.servers["orphan"].connectionStatus).toBe("disconnected");
    });
  });

  describe("SET_INITIALIZATION_INFO", () => {
    it("stores initialization info on server", () => {
      const server = createServer("test");
      const project: Project = {
        id: "project-1",
        name: "Test",
        servers: { test: server },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const state = createInitialState({
        servers: { test: server },
        projects: { "project-1": project },
        activeProjectId: "project-1",
      });
      const initInfo = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "Test Server", version: "1.0.0" },
      };

      const result = appReducer(state, {
        type: "SET_INITIALIZATION_INFO",
        name: "test",
        initInfo,
      });

      expect(result.servers["test"].initializationInfo).toEqual(initInfo);
    });

    it("returns unchanged state if server does not exist", () => {
      const state = createInitialState();

      const result = appReducer(state, {
        type: "SET_INITIALIZATION_INFO",
        name: "nonexistent",
        initInfo: {} as any,
      });

      expect(result).toBe(state);
    });
  });

  describe("Project actions", () => {
    describe("CREATE_WORKSPACE", () => {
      it("adds new project to state", () => {
        const state = createInitialState();
        const newProject: Project = {
          id: "new-project",
          name: "New Project",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = appReducer(state, {
          type: "CREATE_WORKSPACE",
          project: newProject,
        });

        expect(result.projects["new-project"]).toEqual(newProject);
      });
    });

    describe("UPDATE_WORKSPACE", () => {
      it("updates project with partial data", () => {
        const state = createInitialState();

        const result = appReducer(state, {
          type: "UPDATE_WORKSPACE",
          projectId: "project-1",
          updates: { name: "Updated Name", description: "New description" },
        });

        expect(result.projects["project-1"].name).toBe("Updated Name");
        expect(result.projects["project-1"].description).toBe(
          "New description",
        );
      });

      it("returns unchanged state if project does not exist", () => {
        const state = createInitialState();

        const result = appReducer(state, {
          type: "UPDATE_WORKSPACE",
          projectId: "nonexistent",
          updates: { name: "Should not apply" },
        });

        expect(result).toBe(state);
      });
    });

    describe("DELETE_WORKSPACE", () => {
      it("removes project from state", () => {
        const extraProject: Project = {
          id: "extra",
          name: "Extra",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const state = createInitialState({
          projects: {
            ...createInitialState().projects,
            extra: extraProject,
          },
        });

        const result = appReducer(state, {
          type: "DELETE_WORKSPACE",
          projectId: "extra",
        });

        expect(result.projects["extra"]).toBeUndefined();
      });
    });

    describe("SWITCH_WORKSPACE", () => {
      it("switches to target project and resets servers", () => {
        const targetProject: Project = {
          id: "target",
          name: "Target",
          servers: {
            "target-server": createServer("target-server"),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const state = createInitialState({
          projects: {
            ...createInitialState().projects,
            target: targetProject,
          },
          selectedServer: "old-server",
        });

        const result = appReducer(state, {
          type: "SWITCH_WORKSPACE",
          projectId: "target",
        });

        expect(result.activeProjectId).toBe("target");
        expect(result.selectedServer).toBe("none");
        expect(result.selectedMultipleServers).toEqual([]);
        expect(result.servers["target-server"]).toBeDefined();
        expect(result.servers["target-server"].connectionStatus).toBe(
          "disconnected",
        );
      });

      it("returns unchanged state if project does not exist", () => {
        const state = createInitialState();

        const result = appReducer(state, {
          type: "SWITCH_WORKSPACE",
          projectId: "nonexistent",
        });

        expect(result).toBe(state);
      });
    });

    describe("SET_DEFAULT_WORKSPACE", () => {
      it("sets default flag on specified project", () => {
        const project2: Project = {
          id: "project-2",
          name: "Second",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: false,
        };
        const state = createInitialState({
          projects: {
            ...createInitialState().projects,
            "project-2": project2,
          },
        });

        const result = appReducer(state, {
          type: "SET_DEFAULT_WORKSPACE",
          projectId: "project-2",
        });

        expect(result.projects["project-1"].isDefault).toBe(false);
        expect(result.projects["project-2"].isDefault).toBe(true);
      });
    });

    describe("DUPLICATE_WORKSPACE", () => {
      it("creates copy of project with new name", () => {
        const sourceProject: Project = {
          id: "source",
          name: "Source",
          description: "Original",
          servers: { server: createServer("server") },
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          isDefault: true,
        };
        const state = createInitialState({
          projects: {
            ...createInitialState().projects,
            source: sourceProject,
          },
        });

        const result = appReducer(state, {
          type: "DUPLICATE_WORKSPACE",
          projectId: "source",
          newName: "Source Copy",
        });

        const newProjects = Object.values(result.projects).filter(
          (w) => w.name === "Source Copy",
        );
        expect(newProjects).toHaveLength(1);
        const copy = newProjects[0];
        expect(copy.id).not.toBe("source");
        expect(copy.description).toBe("Original");
        expect(copy.isDefault).toBe(false); // Never copy isDefault
        expect(Object.keys(copy.servers)).toEqual(["server"]);
      });

      it("returns unchanged state if source project does not exist", () => {
        const state = createInitialState();

        const result = appReducer(state, {
          type: "DUPLICATE_WORKSPACE",
          projectId: "nonexistent",
          newName: "Copy",
        });

        expect(result).toBe(state);
      });
    });

    describe("IMPORT_WORKSPACE", () => {
      it("adds imported project to state", () => {
        const state = createInitialState();
        const imported: Project = {
          id: "imported",
          name: "Imported",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = appReducer(state, {
          type: "IMPORT_WORKSPACE",
          project: imported,
        });

        expect(result.projects["imported"]).toEqual(imported);
      });
    });
  });
});
