import {
  AppState,
  createInitialAppState,
  createLocalDefaultProject,
  ServerWithName,
  Project,
} from "./app-types";
import { isProjectClientConfig } from "@/lib/client-config";
import { HOSTED_MODE } from "@/lib/config";
import { clearPersistedOAuthTraces } from "@/lib/oauth/oauth-trace";

const STORAGE_KEY = "mcp-inspector-state";
const PROJECTS_STORAGE_KEY = "mcp-inspector-projects";
const LEGACY_WORKSPACES_STORAGE_KEY = "mcp-inspector-workspaces";

function omitLiveOAuthTrace<T extends { lastOAuthTrace?: unknown }>(
  server: T
): Omit<T, "lastOAuthTrace"> {
  const persistedServer = { ...server };
  delete persistedServer.lastOAuthTrace;
  return persistedServer;
}

function reviveServer(name: string, server: any): ServerWithName {
  const persistedServer = omitLiveOAuthTrace(server ?? {});
  const cfg: any = persistedServer.config;
  let nextCfg = cfg;
  if (cfg && typeof cfg.url === "string") {
    try {
      nextCfg = { ...cfg, url: new URL(cfg.url) };
    } catch {
      // ignore invalid URL
    }
  }
  return {
    ...persistedServer,
    name: persistedServer.name ?? name,
    config: nextCfg,
    connectionStatus: persistedServer.connectionStatus || "disconnected",
    retryCount: persistedServer.retryCount || 0,
    lastConnectionTime: persistedServer.lastConnectionTime
      ? new Date(persistedServer.lastConnectionTime)
      : new Date(),
    enabled: persistedServer.enabled !== false,
  } as ServerWithName;
}

function serializeServerForStorage(server: ServerWithName) {
  const persistedServer = omitLiveOAuthTrace(server);
  const cfg: any = server.config;
  const serializedConfig =
    cfg && cfg.url instanceof URL ? { ...cfg, url: cfg.url.toString() } : cfg;

  return {
    ...persistedServer,
    config: serializedConfig,
  };
}

export function loadAppState(): AppState {
  try {
    clearPersistedOAuthTraces();

    if (HOSTED_MODE) {
      return createInitialAppState();
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    const currentProjectsRaw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    const legacyWorkspacesRaw = localStorage.getItem(
      LEGACY_WORKSPACES_STORAGE_KEY
    );
    const projectsRaw = currentProjectsRaw ?? legacyWorkspacesRaw;

    // Load projects
    let projects: Record<string, Project> = {};
    let activeProjectId: string | null = null;

    if (projectsRaw) {
      try {
        const parsedProjects = JSON.parse(projectsRaw);
        const rawProjects =
          parsedProjects.projects ?? parsedProjects.workspaces ?? {};
        projects = Object.fromEntries(
          Object.entries(rawProjects).map(([id, project]: [string, any]) => [
            id,
            {
              ...project,
              canDeleteProject:
                project.canDeleteProject ?? project.canDeleteWorkspace,
              sharedProjectId:
                project.sharedProjectId ?? project.sharedWorkspaceId,
              clientConfig: isProjectClientConfig(project.clientConfig)
                ? project.clientConfig
                : undefined,
              servers: Object.fromEntries(
                Object.entries(project.servers || {}).map(([name, server]) => [
                  name,
                  reviveServer(name, server),
                ])
              ),
              createdAt: new Date(project.createdAt),
              updatedAt: new Date(project.updatedAt),
            },
          ])
        );
        activeProjectId =
          parsedProjects.activeProjectId ??
          parsedProjects.activeWorkspaceId ??
          null;
      } catch (e) {
        console.error("Failed to parse projects from storage", e);
      }
    }

    // If no projects exist, create a local default project with a real id.
    if (Object.keys(projects).length === 0) {
      // Try to migrate from old storage format
      let migratedServers: Record<string, ServerWithName> = {};
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          migratedServers = Object.fromEntries(
            Object.entries(parsed.servers || {}).map(([name, server]) => [
              name,
              reviveServer(name, server),
            ])
          );
        } catch (e) {
          console.error("Failed to migrate old state", e);
        }
      }

      const project = createLocalDefaultProject({ servers: migratedServers });
      projects = { [project.id]: project };
      activeProjectId = project.id;
    }

    let resolvedActiveProjectId =
      activeProjectId && projects[activeProjectId]
        ? activeProjectId
        : Object.values(projects).find((project) => project.isDefault)?.id ??
          Object.keys(projects)[0];
    if (!resolvedActiveProjectId) {
      const project = createLocalDefaultProject();
      projects = { [project.id]: project };
      resolvedActiveProjectId = project.id;
    }
    const activeProject = projects[resolvedActiveProjectId];
    const parsed = raw ? JSON.parse(raw) : {};

    return {
      projects,
      activeProjectId: resolvedActiveProjectId,
      servers: activeProject?.servers || {},
      selectedServer: parsed.selectedServer || "none",
      selectedMultipleServers: parsed.selectedMultipleServers || [],
      isMultiSelectMode: parsed.isMultiSelectMode || false,
    } as AppState;
  } catch (e) {
    console.error("Failed to load app state", e);
    return createInitialAppState();
  }
}

export function saveAppState(state: AppState) {
  try {
    if (HOSTED_MODE) {
      return;
    }

    // Save projects separately
    const projectsData = {
      activeProjectId: state.activeProjectId,
      projects: Object.fromEntries(
        Object.entries(state.projects).map(([id, project]) => [
          id,
          {
            ...project,
            servers: Object.fromEntries(
              Object.entries(project.servers).map(([name, server]) => {
                return [name, serializeServerForStorage(server)];
              })
            ),
          },
        ])
      ),
    };
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projectsData));

    // Save the rest of state (for backward compatibility and non-project data)
    const serializable = {
      selectedServer: state.selectedServer,
      selectedMultipleServers: state.selectedMultipleServers,
      isMultiSelectMode: state.isMultiSelectMode,
      servers: Object.fromEntries(
        Object.entries(state.servers).map(([name, server]) => {
          return [name, serializeServerForStorage(server)];
        })
      ),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (e) {
    console.error("Failed to save app state", e);
  }
}
