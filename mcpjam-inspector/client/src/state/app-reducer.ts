import {
  AppAction,
  AppState,
  ConnectionStatus,
  ServerWithName,
} from "./app-types";
import type { ProjectClientConfig } from "@/lib/client-config";
import {
  describeError,
  isNormalizedError,
  type NormalizedError,
} from "@mcpjam/sdk/browser";

/**
 * Helper used by failure-path reducer branches: when the dispatcher
 * supplied a richer `normalized` block (e.g. forwarded from a
 * `WebApiError` or hosted-route envelope) use it; otherwise derive one
 * from the message string so every failure-path writer ends up with a
 * usable `lastNormalizedError` for the ErrorCard renderer.
 *
 * Re-validates the incoming `normalized` shape — `webPost` populates it
 * from any object in the response body, so a partial payload (older
 * server, schema drift, proxy mangling) would otherwise be stored and
 * later shadow the real message at the renderer (which prefers
 * `lastNormalizedError` over `lastError`). Invalid shapes fall through
 * to the message-string derivation, which always produces a complete
 * block via `describeError`.
 *
 * Returning `undefined` for empty messages keeps the reducer free of
 * synthetic "unknown error" entries that would obscure healthy state.
 */
function resolveNormalized(
  message: string | undefined,
  normalized: NormalizedError | undefined
): NormalizedError | undefined {
  if (isNormalizedError(normalized)) return normalized;
  if (!message) return undefined;
  return describeError(new Error(message));
}

const setStatus = (
  server: ServerWithName,
  status: ConnectionStatus,
  patch: Partial<ServerWithName> = {}
): ServerWithName => ({ ...server, connectionStatus: status, ...patch });

const buildProjectServerProjection = (
  server: ServerWithName
): ServerWithName => ({
  name: server.name,
  config: server.config,
  lastConnectionTime: server.lastConnectionTime,
  connectionStatus: "disconnected",
  retryCount: 0,
  enabled: server.enabled ?? true,
  ...(server.initializationInfo
    ? { initializationInfo: server.initializationInfo }
    : {}),
  ...(server.useOAuth === undefined ? {} : { useOAuth: server.useOAuth }),
  ...(server.hasClientSecret === undefined
    ? {}
    : { hasClientSecret: server.hasClientSecret }),
  ...(server.hasEnv === undefined ? {} : { hasEnv: server.hasEnv }),
  ...(server.hasHeaders === undefined ? {} : { hasHeaders: server.hasHeaders }),
  ...(server.hasBearerToken === undefined
    ? {}
    : { hasBearerToken: server.hasBearerToken }),
  ...(server.oauthFlowProfile
    ? { oauthFlowProfile: server.oauthFlowProfile }
    : {}),
});

const redactionFlagsFromConfig = (
  config: ServerWithName["config"] | undefined
): Partial<ServerWithName> => {
  if (!config || typeof config !== "object") {
    return {};
  }

  const record = config as Record<string, unknown>;
  return {
    ...(record.hasEnv === true ? { hasEnv: true } : {}),
    ...(record.hasHeaders === true ? { hasHeaders: true } : {}),
    ...(record.hasBearerToken === true ? { hasBearerToken: true } : {}),
  };
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "HYDRATE_STATE":
      return action.payload;

    case "CLEAR_RUNTIME_STATE":
      return {
        ...state,
        servers: {},
        selectedServer: "none",
        selectedMultipleServers: [],
      };

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
      // Check state.servers first, then fallback to project servers (for cloud-synced servers)
      // If server doesn't exist anywhere, create it (for servers from Convex remote projects)
      const activeProject = state.projects[state.activeProjectId];
      const existing =
        state.servers[action.name] ?? activeProject?.servers[action.name];
      // Create server entry if it doesn't exist (for Convex-synced servers)
      const baseServer: ServerWithName = existing ?? {
        name: action.name,
        config: action.config,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        retryCount: 0,
        enabled: true,
      };
      const shouldUseOAuth =
        action.useOAuth ??
        (baseServer.useOAuth === true || action.tokens != null);
      const nextServer = setStatus(baseServer, "connected", {
        config: action.config,
        lastConnectionTime: new Date(),
        retryCount: 0,
        lastError: undefined,
        lastNormalizedError: undefined,
        lastOAuthTrace: action.oauthTrace,
        oauthTokens: action.tokens,
        enabled: true,
        // Hosted project OAuth can succeed without browser-side tokens.
        // Preserve explicit auth mode when the dispatch provides it.
        useOAuth: shouldUseOAuth,
      });
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: nextServer,
        },
        projects: {
          ...state.projects,
          [state.activeProjectId]: {
            ...activeProject,
            servers: {
              ...activeProject.servers,
              [action.name]: nextServer,
            },
            updatedAt: new Date(),
          },
        },
      };
    }

    case "CONNECT_FAILURE": {
      // Check state.servers first, then fallback to project servers (for cloud-synced servers)
      const activeProject = state.projects[state.activeProjectId];
      const existing =
        state.servers[action.name] ?? activeProject?.servers[action.name];
      if (!existing) return state;
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: setStatus(existing, "failed", {
            retryCount: existing.retryCount,
            lastError: action.error,
            lastNormalizedError: resolveNormalized(
              action.error,
              action.normalized
            ),
            lastOAuthTrace: action.oauthTrace,
          }),
        },
      };
    }

    case "RECONNECT_REQUEST": {
      // Check state.servers first, then fallback to project servers (for cloud-synced servers)
      // If server doesn't exist anywhere, create it (for servers from Convex remote projects)
      const activeProject = state.projects[state.activeProjectId];
      const existing =
        state.servers[action.name] ?? activeProject?.servers[action.name];
      // Create server entry if it doesn't exist (for Convex-synced servers)
      const baseServer: ServerWithName = existing ?? {
        name: action.name,
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
          [action.name]: nextServer,
        },
        // When the user explicitly reconnects a server, make it the selected
        // one so downstream tabs (App Builder, Tools, etc.) follow the user's
        // most recent intent instead of a stale prior selection.
        selectedServer: action.select ? action.name : state.selectedServer,
      };
    }

    case "DISCONNECT": {
      // Check state.servers first, then fallback to project servers (for cloud-synced servers)
      const activeProject = state.projects[state.activeProjectId];
      const existing =
        state.servers[action.name] ?? activeProject?.servers[action.name];
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
            lastNormalizedError: action.error
              ? resolveNormalized(action.error, action.normalized)
              : existing.lastNormalizedError,
          }),
        },
        selectedServer: nextSelected,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.name
        ),
      };
    }

    case "REMOVE_SERVER": {
      const { [action.name]: _, ...rest } = state.servers;
      const activeProject = state.projects[state.activeProjectId];
      const { [action.name]: __, ...restProjectServers } =
        activeProject.servers;
      return {
        ...state,
        servers: rest,
        selectedServer:
          state.selectedServer === action.name ? "none" : state.selectedServer,
        selectedMultipleServers: state.selectedMultipleServers.filter(
          (n) => n !== action.name
        ),
        projects: {
          ...state.projects,
          [state.activeProjectId]: {
            ...activeProject,
            servers: restProjectServers,
            updatedAt: new Date(),
          },
        },
      };
    }

    case "SYNC_AGENT_STATUS": {
      const map = new Map(action.servers.map((s) => [s.id, s]));
      const updated: AppState["servers"] = {};
      for (const [name, server] of Object.entries(state.servers)) {
        const inFlight = server.connectionStatus === "connecting";
        if (inFlight) {
          updated[name] = server;
          continue;
        }
        const agentInfo = map.get(name);
        if (agentInfo) {
          updated[name] = {
            ...server,
            connectionStatus: agentInfo.status,
            ...(agentInfo.config ? { config: agentInfo.config } : {}),
            ...redactionFlagsFromConfig(agentInfo.config),
          };
        } else {
          updated[name] = { ...server, connectionStatus: "disconnected" };
        }
      }

      const activeProject = state.projects[state.activeProjectId];
      const projectServers = { ...(activeProject?.servers ?? {}) };
      let shouldUpdateProject = false;
      for (const agentInfo of action.servers) {
        if (!agentInfo.config) {
          continue;
        }

        if (!updated[agentInfo.id]) {
          updated[agentInfo.id] = {
            name: agentInfo.id,
            config: agentInfo.config,
            lastConnectionTime: new Date(),
            connectionStatus: agentInfo.status,
            retryCount: 0,
            enabled: true,
            ...redactionFlagsFromConfig(agentInfo.config),
          };
        }

        if (!projectServers[agentInfo.id]) {
          projectServers[agentInfo.id] = buildProjectServerProjection(
            updated[agentInfo.id]
          );
          shouldUpdateProject = true;
        }
      }

      return {
        ...state,
        servers: updated,
        ...(activeProject && shouldUpdateProject
          ? {
              projects: {
                ...state.projects,
                [state.activeProjectId]: {
                  ...activeProject,
                  servers: projectServers,
                  updatedAt: new Date(),
                },
              },
            }
          : {}),
      };
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
      const activeProject = state.projects[state.activeProjectId];
      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: nextServer,
        },
        projects: {
          ...state.projects,
          [state.activeProjectId]: {
            ...activeProject,
            servers: {
              ...activeProject.servers,
              [action.name]: nextServer,
            },
            updatedAt: new Date(),
          },
        },
      };
    }

    case "SET_SERVER_OAUTH_TRACE": {
      const activeProject = state.projects[state.activeProjectId];
      const existing =
        state.servers[action.name] ?? activeProject?.servers[action.name];
      if (!existing) return state;

      const nextServer = {
        ...existing,
        lastOAuthTrace: action.oauthTrace,
      };

      return {
        ...state,
        servers: {
          ...state.servers,
          [action.name]: nextServer,
        },
        projects: {
          ...state.projects,
          [state.activeProjectId]: {
            ...activeProject,
            servers: {
              ...activeProject.servers,
              [action.name]: nextServer,
            },
            updatedAt: new Date(),
          },
        },
      };
    }

    case "CREATE_PROJECT": {
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.project.id]: action.project,
        },
      };
    }

    case "UPDATE_PROJECT": {
      const project = state.projects[action.projectId];
      if (!project) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            ...action.updates,
            updatedAt: new Date(),
          },
        },
      };
    }

    case "UPDATE_PROJECT_CLIENT_CONFIG_SLICE": {
      // Merge a single section of clientConfig into the project's
      // current value. Reading clientConfig from the latest state here
      // (rather than recomposing from a stale snapshot at the call
      // site) is what prevents a slow connection save from clobbering
      // a newer host-context save (and vice versa). See P2 in PR #237/#2051.
      const project = state.projects[action.projectId];
      if (!project) return state;
      const baseClientConfig: ProjectClientConfig = project.clientConfig
        ? project.clientConfig
        : {
            version: 1,
            connectionDefaults: undefined,
            clientCapabilities: {},
            hostContext: {},
          };
      const nextClientConfig: ProjectClientConfig =
        action.slice.kind === "connection"
          ? {
              ...baseClientConfig,
              connectionDefaults: action.slice.connectionDefaults,
              clientCapabilities: action.slice.clientCapabilities,
            }
          : {
              ...baseClientConfig,
              hostContext: action.slice.hostContext,
            };
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            clientConfig: nextClientConfig,
            updatedAt: new Date(),
          },
        },
      };
    }

    case "DELETE_PROJECT": {
      const { [action.projectId]: _, ...remainingProjects } = state.projects;
      return {
        ...state,
        projects: remainingProjects,
      };
    }

    case "SWITCH_PROJECT": {
      const targetProject = state.projects[action.projectId];
      if (!targetProject) return state;

      // Mark all servers as disconnected when switching projects
      // since we disconnect them before switching
      const disconnectedServers = Object.fromEntries(
        Object.entries(targetProject.servers).map(([name, server]) => [
          name,
          { ...server, connectionStatus: "disconnected" as ConnectionStatus },
        ])
      );

      return {
        ...state,
        activeProjectId: action.projectId,
        servers: disconnectedServers,
        selectedServer: "none",
        selectedMultipleServers: [],
      };
    }

    case "SET_DEFAULT_PROJECT": {
      const updatedProjects = Object.fromEntries(
        Object.entries(state.projects).map(([id, project]) => [
          id,
          { ...project, isDefault: id === action.projectId },
        ])
      );
      return {
        ...state,
        projects: updatedProjects,
      };
    }

    case "IMPORT_PROJECT": {
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.project.id]: action.project,
        },
      };
    }

    case "DUPLICATE_PROJECT": {
      const sourceProject = state.projects[action.projectId];
      if (!sourceProject) return state;
      const newProject = {
        ...sourceProject,
        id: `project_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: action.newName,
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: false,
      };
      return {
        ...state,
        projects: {
          ...state.projects,
          [newProject.id]: newProject,
        },
      };
    }

    default:
      return state;
  }
}
