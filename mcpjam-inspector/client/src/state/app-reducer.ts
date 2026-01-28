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
        servers: { ...state.servers, [action.server.id]: action.server },
      };

    case "RENAME_SERVER": {
      const existing = state.servers[action.id];
      if (!existing) return state;
      const renamed = { ...existing, name: action.newName };
      const updatedWorkspaces: Record<string, Workspace> = {};
      for (const [workspaceId, workspace] of Object.entries(state.workspaces)) {
        if (!workspace.servers[action.id]) {
          updatedWorkspaces[workspaceId] = workspace;
          continue;
        }
        updatedWorkspaces[workspaceId] = {
          ...workspace,
          servers: {
            ...workspace.servers,
            [action.id]: {
              ...workspace.servers[action.id],
              name: action.newName,
            },
          },
          updatedAt: new Date(),
        };
      }
      return {
        ...state,
        servers: { ...state.servers, [action.id]: renamed },
        workspaces: updatedWorkspaces,
      };
    }

    case "CONNECT_REQUEST": {
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      const existing =
        state.servers[action.id] ?? activeWorkspace?.servers[action.id];
      const server: ServerWithName = existing
        ? setStatus(existing, "connecting", {
            enabled: true,
            name: action.name,
          })
        : ({
            id: action.id,
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
          [action.id]: { ...server, name: action.name, config: action.config },
        },
        selectedServer: action.select ? action.id : state.selectedServer,
      };
    }

    case "CONNECT_SUCCESS": {
      // Check state.servers first, then fallback to workspace servers (for cloud-synced servers)
      // If server doesn't exist anywhere, create it (for servers from Convex remote workspaces)
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      const existing =
        state.servers[action.id] ?? activeWorkspace?.servers[action.id];
      // Create server entry if it doesn't exist (for Convex-synced servers)
      const baseServer: ServerWithName = existing ?? {
        id: action.id,
        name: action.name,
        config: action.config,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        retryCount: 0,
        enabled: true,
      };
      const nextServer = setStatus(baseServer, "connected", {
        name: action.name,
        config: action.config,
        lastConnectionTime: new Date(),
        retryCount: 0,
        lastError: undefined,
        oauthTokens: action.tokens,
        enabled: true,
        // Track whether this server uses OAuth based on whether tokens were provided
        useOAuth: action.tokens != null,
      });
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.id]: nextServer,
        },
        workspaces:
          activeWorkspace !== undefined
            ? {
                ...state.workspaces,
                [state.activeWorkspaceId]: {
                  ...activeWorkspace,
                  servers: {
                    ...activeWorkspace.servers,
                    [action.id]: nextServer,
                  },
                  updatedAt: new Date(),
                },
              }
            : state.workspaces,
      };
    }

    case "CONNECT_FAILURE": {
      // Check state.servers first, then fallback to workspace servers (for cloud-synced servers)
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      const existing =
        state.servers[action.id] ?? activeWorkspace?.servers[action.id];
      if (!existing) return state;
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.id]: setStatus(existing, "failed", {
            retryCount: existing.retryCount,
            lastError: action.error,
          }),
        },
      };
    }

    case "RECONNECT_REQUEST": {
      // Check state.servers first, then fallback to workspace servers (for cloud-synced servers)
      // If server doesn't exist anywhere, create it (for servers from Convex remote workspaces)
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      const existing =
        state.servers[action.id] ?? activeWorkspace?.servers[action.id];
      // Create server entry if it doesn't exist (for Convex-synced servers)
      const baseServer: ServerWithName = existing ?? {
        id: action.id,
        name: existing?.name ?? "Server",
        config: action.config,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        retryCount: 0,
        enabled: true,
      };
      const nextServer = setStatus(baseServer, "connecting", { enabled: true });
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.id]: nextServer,
        },
      };
    }

    case "DISCONNECT": {
      // Check state.servers first, then fallback to workspace servers (for cloud-synced servers)
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      const existing =
        state.servers[action.id] ?? activeWorkspace?.servers[action.id];
      if (!existing) return state;
      const nextSelected =
        state.selectedServer === action.id ? "none" : state.selectedServer;
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.id]: setStatus(existing, "disconnected", {
            enabled: false,
            lastError: action.error ?? existing.lastError,
          }),
        },
        selectedServer: nextSelected,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.id,
        ),
      };
    }

    case "REMOVE_SERVER": {
      const { [action.id]: _, ...rest } = state.servers;
      const activeWorkspace = state.workspaces[state.activeWorkspaceId];
      const { [action.id]: __, ...restWorkspaceServers } =
        activeWorkspace?.servers ?? {};
      return {
        ...state,
        servers: rest,
        selectedServer:
          state.selectedServer === action.id ? "none" : state.selectedServer,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.id,
        ),
        workspaces:
          activeWorkspace !== undefined
            ? {
                ...state.workspaces,
                [state.activeWorkspaceId]: {
                  ...activeWorkspace,
                  servers: restWorkspaceServers,
                  updatedAt: new Date(),
                },
              }
            : state.workspaces,
      };
    }

    case "SYNC_AGENT_STATUS": {
      const map = new Map(action.servers.map((s) => [s.id, s.status]));
      const updated: AppState["servers"] = {};
      for (const [id, server] of Object.entries(state.servers)) {
        const inFlight = server.connectionStatus === "connecting";
        if (inFlight) {
          updated[id] = server;
          continue;
        }
        const agentStatus = map.get(id);
        if (agentStatus) {
          updated[id] = { ...server, connectionStatus: agentStatus };
        } else {
          updated[id] = { ...server, connectionStatus: "disconnected" };
        }
      }
      return { ...state, servers: updated };
    }

    case "SELECT_SERVER":
      return { ...state, selectedServer: action.id };

    case "SET_MULTI_SELECTED":
      return { ...state, selectedMultipleServers: action.ids };

    case "SET_MULTI_MODE":
      return {
        ...state,
        isMultiSelectMode: action.enabled,
        selectedMultipleServers: action.enabled
          ? []
          : state.selectedMultipleServers,
      };

    case "SET_INITIALIZATION_INFO": {
      const existing = state.servers[action.id];
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
          [action.id]: nextServer,
        },
        workspaces:
          activeWorkspace !== undefined
            ? {
                ...state.workspaces,
                [state.activeWorkspaceId]: {
                  ...activeWorkspace,
                  servers: {
                    ...activeWorkspace.servers,
                    [action.id]: nextServer,
                  },
                  updatedAt: new Date(),
                },
              }
            : state.workspaces,
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
        Object.entries(targetWorkspace.servers).map(([id, server]) => [
          id,
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
