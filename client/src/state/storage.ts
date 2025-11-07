import {
  AppState,
  initialAppState,
  ServerWithName,
  Workspace,
} from "./app-types";

const STORAGE_KEY = "mcp-inspector-state";
const WORKSPACES_STORAGE_KEY = "mcp-inspector-workspaces";

function reviveServer(server: any): ServerWithName {
  const cfg: any = server.config;
  let nextCfg = cfg;
  if (cfg && typeof cfg.url === "string") {
    try {
      nextCfg = { ...cfg, url: new URL(cfg.url) };
    } catch {
      // ignore invalid URL
    }
  }
  return {
    ...server,
    config: nextCfg,
    connectionStatus: server.connectionStatus || "disconnected",
    retryCount: server.retryCount || 0,
    lastConnectionTime: server.lastConnectionTime
      ? new Date(server.lastConnectionTime)
      : new Date(),
    enabled: server.enabled !== false,
  } as ServerWithName;
}

export function loadAppState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const workspacesRaw = localStorage.getItem(WORKSPACES_STORAGE_KEY);

    // Load workspaces
    let workspaces: Record<string, Workspace> = {};
    let activeWorkspaceId = "default";

    if (workspacesRaw) {
      try {
        const parsedWorkspaces = JSON.parse(workspacesRaw);
        workspaces = Object.fromEntries(
          Object.entries(parsedWorkspaces.workspaces || {}).map(
            ([id, workspace]: [string, any]) => [
              id,
              {
                ...workspace,
                servers: Object.fromEntries(
                  Object.entries(workspace.servers || {}).map(
                    ([name, server]) => [name, reviveServer(server)],
                  ),
                ),
                createdAt: new Date(workspace.createdAt),
                updatedAt: new Date(workspace.updatedAt),
              },
            ],
          ),
        );
        activeWorkspaceId = parsedWorkspaces.activeWorkspaceId || "default";
      } catch (e) {
        console.error("Failed to parse workspaces from storage", e);
      }
    }

    // If no workspaces exist or default is missing, create it
    if (Object.keys(workspaces).length === 0 || !workspaces.default) {
      // Try to migrate from old storage format
      let migratedServers: Record<string, ServerWithName> = {};
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          migratedServers = Object.fromEntries(
            Object.entries(parsed.servers || {}).map(([name, server]) => [
              name,
              reviveServer(server),
            ]),
          );
        } catch (e) {
          console.error("Failed to migrate old state", e);
        }
      }

      workspaces = {
        default: {
          id: "default",
          name: "Default",
          description: "Default workspace",
          servers: migratedServers,
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: true,
        },
      };
      activeWorkspaceId = "default";
    }

    const activeWorkspace = workspaces[activeWorkspaceId];
    const parsed = raw ? JSON.parse(raw) : {};

    return {
      workspaces,
      activeWorkspaceId,
      servers: activeWorkspace?.servers || {},
      selectedServer: parsed.selectedServer || "none",
      selectedMultipleServers: parsed.selectedMultipleServers || [],
      isMultiSelectMode: parsed.isMultiSelectMode || false,
    } as AppState;
  } catch (e) {
    console.error("Failed to load app state", e);
    return initialAppState;
  }
}

export function saveAppState(state: AppState) {
  try {
    // Save workspaces separately
    const workspacesData = {
      activeWorkspaceId: state.activeWorkspaceId,
      workspaces: Object.fromEntries(
        Object.entries(state.workspaces).map(([id, workspace]) => [
          id,
          {
            ...workspace,
            servers: Object.fromEntries(
              Object.entries(workspace.servers).map(([name, server]) => {
                const cfg: any = server.config;
                const serializedConfig =
                  cfg && cfg.url instanceof URL
                    ? { ...cfg, url: cfg.url.toString() }
                    : cfg;
                return [name, { ...server, config: serializedConfig }];
              }),
            ),
          },
        ]),
      ),
    };
    localStorage.setItem(
      WORKSPACES_STORAGE_KEY,
      JSON.stringify(workspacesData),
    );

    // Save the rest of state (for backward compatibility and non-workspace data)
    const serializable = {
      selectedServer: state.selectedServer,
      selectedMultipleServers: state.selectedMultipleServers,
      isMultiSelectMode: state.isMultiSelectMode,
      servers: Object.fromEntries(
        Object.entries(state.servers).map(([name, server]) => {
          const cfg: any = server.config;
          const serializedConfig =
            cfg && cfg.url instanceof URL
              ? { ...cfg, url: cfg.url.toString() }
              : cfg;
          return [name, { ...server, config: serializedConfig }];
        }),
      ),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (e) {
    console.error("Failed to save app state", e);
  }
}
