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
      const nextServer = setStatus(existing, "connected", {
        config: action.config,
        lastConnectionTime: new Date(),
        retryCount: 0,
        lastError: undefined,
        oauthTokens: action.tokens,
        enabled: true,
      });
      const activeProfile = state.profiles[state.activeProfileId];
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: nextServer,
        },
        profiles: {
          ...state.profiles,
          [state.activeProfileId]: {
            ...activeProfile,
            servers: {
              ...activeProfile.servers,
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
      const activeProfile = state.profiles[state.activeProfileId];
      const { [action.name]: __, ...restProfileServers } = activeProfile.servers;
      return {
        ...state,
        servers: rest,
        selectedServer:
          state.selectedServer === action.name ? "none" : state.selectedServer,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.name,
        ),
        profiles: {
          ...state.profiles,
          [state.activeProfileId]: {
            ...activeProfile,
            servers: restProfileServers,
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
      const activeProfile = state.profiles[state.activeProfileId];
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: nextServer,
        },
        profiles: {
          ...state.profiles,
          [state.activeProfileId]: {
            ...activeProfile,
            servers: {
              ...activeProfile.servers,
              [action.name]: nextServer,
            },
            updatedAt: new Date(),
          },
        },
      };
    }

    case "CREATE_PROFILE": {
      return {
        ...state,
        profiles: {
          ...state.profiles,
          [action.profile.id]: action.profile,
        },
      };
    }

    case "UPDATE_PROFILE": {
      const profile = state.profiles[action.profileId];
      if (!profile) return state;
      return {
        ...state,
        profiles: {
          ...state.profiles,
          [action.profileId]: {
            ...profile,
            ...action.updates,
            updatedAt: new Date(),
          },
        },
      };
    }

    case "DELETE_PROFILE": {
      const { [action.profileId]: _, ...remainingProfiles } = state.profiles;
      return {
        ...state,
        profiles: remainingProfiles,
      };
    }

    case "SWITCH_PROFILE": {
      const targetProfile = state.profiles[action.profileId];
      if (!targetProfile) return state;
      return {
        ...state,
        activeProfileId: action.profileId,
        servers: { ...targetProfile.servers },
        selectedServer: "none",
        selectedMultipleServers: [],
      };
    }

    case "SET_DEFAULT_PROFILE": {
      const updatedProfiles = Object.fromEntries(
        Object.entries(state.profiles).map(([id, profile]) => [
          id,
          { ...profile, isDefault: id === action.profileId },
        ]),
      );
      return {
        ...state,
        profiles: updatedProfiles,
      };
    }

    case "IMPORT_PROFILE": {
      return {
        ...state,
        profiles: {
          ...state.profiles,
          [action.profile.id]: action.profile,
        },
      };
    }

    case "DUPLICATE_PROFILE": {
      const sourceProfile = state.profiles[action.profileId];
      if (!sourceProfile) return state;
      const newProfile = {
        ...sourceProfile,
        id: `profile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: action.newName,
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: false,
      };
      return {
        ...state,
        profiles: {
          ...state.profiles,
          [newProfile.id]: newProfile,
        },
      };
    }

    default:
      return state;
  }
}
