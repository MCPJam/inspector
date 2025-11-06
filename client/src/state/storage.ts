import { AppState, initialAppState, ServerWithName, Profile } from "./app-types";

const STORAGE_KEY = "mcp-inspector-state";
const PROFILES_STORAGE_KEY = "mcp-inspector-profiles";

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
    const profilesRaw = localStorage.getItem(PROFILES_STORAGE_KEY);

    // Load profiles
    let profiles: Record<string, Profile> = {};
    let activeProfileId = "default";

    if (profilesRaw) {
      try {
        const parsedProfiles = JSON.parse(profilesRaw);
        profiles = Object.fromEntries(
          Object.entries(parsedProfiles.profiles || {}).map(([id, profile]: [string, any]) => [
            id,
            {
              ...profile,
              servers: Object.fromEntries(
                Object.entries(profile.servers || {}).map(([name, server]) => [
                  name,
                  reviveServer(server),
                ])
              ),
              createdAt: new Date(profile.createdAt),
              updatedAt: new Date(profile.updatedAt),
            },
          ])
        );
        activeProfileId = parsedProfiles.activeProfileId || "default";
      } catch (e) {
        console.error("Failed to parse profiles from storage", e);
      }
    }

    // If no profiles exist or default is missing, create it
    if (Object.keys(profiles).length === 0 || !profiles.default) {
      // Try to migrate from old storage format
      let migratedServers: Record<string, ServerWithName> = {};
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          migratedServers = Object.fromEntries(
            Object.entries(parsed.servers || {}).map(([name, server]) => [
              name,
              reviveServer(server),
            ])
          );
        } catch (e) {
          console.error("Failed to migrate old state", e);
        }
      }

      profiles = {
        default: {
          id: "default",
          name: "Default",
          description: "Default profile",
          servers: migratedServers,
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: true,
        },
      };
      activeProfileId = "default";
    }

    const activeProfile = profiles[activeProfileId];
    const parsed = raw ? JSON.parse(raw) : {};

    return {
      profiles,
      activeProfileId,
      servers: activeProfile?.servers || {},
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
    // Save profiles separately
    const profilesData = {
      activeProfileId: state.activeProfileId,
      profiles: Object.fromEntries(
        Object.entries(state.profiles).map(([id, profile]) => [
          id,
          {
            ...profile,
            servers: Object.fromEntries(
              Object.entries(profile.servers).map(([name, server]) => {
                const cfg: any = server.config;
                const serializedConfig =
                  cfg && cfg.url instanceof URL
                    ? { ...cfg, url: cfg.url.toString() }
                    : cfg;
                return [name, { ...server, config: serializedConfig }];
              })
            ),
          },
        ])
      ),
    };
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profilesData));

    // Save the rest of state (for backward compatibility and non-profile data)
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
        })
      ),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (e) {
    console.error("Failed to save app state", e);
  }
}
