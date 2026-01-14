import {
  AppAction,
  AppState,
  ConnectionStatus,
  ServerWithName,
  Workspace,
} from "./app-types";

const setStatus = (
  server: ServerWithName,
  status: ConnectionStatus,
  patch: Partial<ServerWithName> = {},
): ServerWithName => ({ ...server, connectionStatus: status, ...patch });

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "HYDRATE_STATE":
      return action.payload;

    case "UPSERT_SERVER":
      return {
        ...state,
        servers: { ...state.servers, [action.name]: action.server },
      };

    case "CONNECT_REQUEST": {
      const existing = state.servers[action.name];
      const server: ServerWithName = existing
        ? setStatus(existing, "connecting", { enabled: true })
        : ({
            name: action.name,
            config: action.config,
            lastConnectionTime: new Date(),
            connectionStatus: "connecting",
            retryCount: 0,
            enabled: true,
          } as ServerWithName);
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: { ...server, config: action.config },
        },
        selectedServer: action.select ? action.name : state.selectedServer,
      };
    }

    case "CONNECT_SUCCESS": {
      const existing = state.servers[action.name];
      if (!existing) return state;
      const nextServer = setStatus(existing, "connected", {
        config: action.config,
        lastConnectionTime: new Date(),
        retryCount: 0,
        lastError: undefined,
        oauthTokens: action.tokens,
        enabled: true,
        // Track whether this server uses OAuth based on whether tokens were provided
        useOAuth: action.tokens != null,
      });
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: nextServer,
        },
        workspaces: {
          ...state.workspaces,
          [state.activeWorkspaceId]: {
            ...activeWorkspace,
            servers: {
              ...activeWorkspace.servers,
              [action.name]: nextServer,
            },
            updatedAt: new Date(),
          },
        },
      };
    }

    case "CONNECT_FAILURE": {
      const existing = state.servers[action.name];
      if (!existing) return state;
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: setStatus(existing, "failed", {
            retryCount: existing.retryCount,
            lastError: action.error,
          }),
        },
      };
    }

    case "RECONNECT_REQUEST": {
      const existing = state.servers[action.name];
      if (!existing) return state;
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: setStatus(existing, "connecting", { enabled: true }),
        },
      };
    }

    case "DISCONNECT": {
      const existing = state.servers[action.name];
      if (!existing) return state;
      const nextSelected =
        state.selectedServer === action.name ? "none" : state.selectedServer;
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: setStatus(existing, "disconnected", {
            enabled: false,
            lastError: action.error ?? existing.lastError,
          }),
        },
        selectedServer: nextSelected,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.name,
        ),
      };
    }

    case "REMOVE_SERVER": {
      const { [action.name]: _, ...rest } = state.servers;
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      const { [action.name]: __, ...restWorkspaceServers } =
        activeWorkspace.servers;
      return {
        ...state,
        servers: rest,
        selectedServer:
          state.selectedServer === action.name ? "none" : state.selectedServer,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.name,
        ),
        workspaces: {
          ...state.workspaces,
          [state.activeWorkspaceId]: {
            ...activeWorkspace,
            servers: restWorkspaceServers,
            updatedAt: new Date(),
          },
        },
      };
    }

    case "SYNC_AGENT_STATUS": {
      const map = new Map(action.servers.map((s) => [s.id, s.status]));
      const updated: AppState["servers"] = {};
      for (const [name, server] of Object.entries(state.servers)) {
        const inFlight = server.connectionStatus === "connecting";
        if (inFlight) {
          updated[name] = server;
          continue;
        }
        const agentStatus = map.get(name);
        if (agentStatus) {
          updated[name] = { ...server, connectionStatus: agentStatus };
        } else {
          updated[name] = { ...server, connectionStatus: "disconnected" };
        }
      }
      return { ...state, servers: updated };
    }

    case "SELECT_SERVER":
      return { ...state, selectedServer: action.name };

    case "SET_MULTI_SELECTED":
      return { ...state, selectedMultipleServers: action.names };

    case "SET_MULTI_MODE":
      return {
        ...state,
        isMultiSelectMode: action.enabled,
        selectedMultipleServers: action.enabled
          ? []
          : state.selectedMultipleServers,
      };

    case "SET_INITIALIZATION_INFO": {
      const existing = state.servers[action.name];
      if (!existing) return state;
      const nextServer = {
        ...existing,
        initializationInfo: action.initInfo,
      };
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: nextServer,
        },
        workspaces: {
          ...state.workspaces,
          [state.activeWorkspaceId]: {
            ...activeWorkspace,
            servers: {
              ...activeWorkspace.servers,
              [action.name]: nextServer,
            },
            updatedAt: new Date(),
          },
        },
      };
    }

    case "CREATE_WORKSPACE": {
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [action.workspace.id]: action.workspace,
        },
      };
    }

    case "UPDATE_WORKSPACE": {
      const workspace = state.workspaces[action.workspaceId];
      if (!workspace) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [action.workspaceId]: {
            ...workspace,
            ...action.updates,
            updatedAt: new Date(),
          },
        },
      };
    }

    case "DELETE_WORKSPACE": {
      const { [action.workspaceId]: _, ...remainingWorkspaces } =
        state.workspaces;
      return {
        ...state,
        workspaces: remainingWorkspaces,
      };
    }

    case "SWITCH_WORKSPACE": {
      const targetWorkspace = state.workspaces[action.workspaceId];
      if (!targetWorkspace) return state;

      // Mark all servers as disconnected when switching workspaces
      // since we disconnect them before switching
      const disconnectedServers = Object.fromEntries(
        Object.entries(targetWorkspace.servers).map(([name, server]) => [
          name,
          { ...server, connectionStatus: "disconnected" as ConnectionStatus },
        ]),
      );

      return {
        ...state,
        activeWorkspaceId: action.workspaceId,
        servers: disconnectedServers,
        selectedServer: "none",
        selectedMultipleServers: [],
      };
    }

    case "SET_DEFAULT_WORKSPACE": {
      const updatedWorkspaces = Object.fromEntries(
        Object.entries(state.workspaces).map(([id, workspace]) => [
          id,
          { ...workspace, isDefault: id === action.workspaceId },
        ]),
      );
      return {
        ...state,
        workspaces: updatedWorkspaces,
      };
    }

    case "IMPORT_WORKSPACE": {
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [action.workspace.id]: action.workspace,
        },
      };
    }

    case "DUPLICATE_WORKSPACE": {
      const sourceWorkspace = state.workspaces[action.workspaceId];
      if (!sourceWorkspace) return state;
      const newWorkspace = {
        ...sourceWorkspace,
        id: `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: action.newName,
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: false,
      };
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [newWorkspace.id]: newWorkspace,
        },
      };
    }

    default:
      return state;
  }
}
