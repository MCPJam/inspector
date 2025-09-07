import { AppState, initialAppState, ServerWithName } from "./app-types";

const STORAGE_KEY = "mcp-inspector-state";

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
    if (!raw) return initialAppState;
    const parsed = JSON.parse(raw);
    const servers = Object.fromEntries(
      Object.entries(parsed.servers || {}).map(([name, server]) => [
        name,
        reviveServer(server),
      ]),
    );
    return {
      servers,
      selectedServer: parsed.selectedServer || "none",
      selectedMultipleServers: parsed.selectedMultipleServers || [],
      isMultiSelectMode: parsed.isMultiSelectMode || false,
    } as AppState;
  } catch {
    return initialAppState;
  }
}

export function saveAppState(state: AppState) {
  const serializable: AppState = {
    ...state,
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
}
