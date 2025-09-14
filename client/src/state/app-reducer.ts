import {
  AppAction,
  AppState,
  ConnectionStatus,
  ServerWithName,
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
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: setStatus(existing, "connected", {
            config: action.config,
            lastConnectionTime: new Date(),
            retryCount: 0,
            lastError: undefined,
            oauthTokens: action.tokens ?? existing.oauthTokens,
            enabled: true,
          }),
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
      return {
        ...state,
        servers: rest,
        selectedServer:
          state.selectedServer === action.name ? "none" : state.selectedServer,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.name,
        ),
      };
    }

    case "SYNC_AGENT_STATUS": {
      const map = new Map(action.servers.map((s) => [s.id, s.status]));
      const updated: AppState["servers"] = {};
      for (const [name, server] of Object.entries(state.servers)) {
        const inFlight =
          server.connectionStatus === "connecting" ||
          server.connectionStatus === "oauth-flow";
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

    default:
      return state;
  }
}
