export type QuickConnectSourceTab = "servers" | "registry";

export interface PendingQuickConnectState {
  serverName: string;
  displayName: string;
  sourceTab: QuickConnectSourceTab;
  createdAt: number;
  registryServerId?: string;
}

const STORAGE_KEY = "mcp-quick-connect-pending";
const LEGACY_STORAGE_KEY = "registry-pending-redirect";

function isSourceTab(value: unknown): value is QuickConnectSourceTab {
  return value === "servers" || value === "registry";
}

export function readPendingQuickConnect(): PendingQuickConnectState | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<PendingQuickConnectState>;
      if (
        typeof parsed.serverName === "string" &&
        typeof parsed.displayName === "string" &&
        typeof parsed.createdAt === "number" &&
        isSourceTab(parsed.sourceTab)
      ) {
        return {
          serverName: parsed.serverName,
          displayName: parsed.displayName,
          sourceTab: parsed.sourceTab,
          createdAt: parsed.createdAt,
          registryServerId:
            typeof parsed.registryServerId === "string"
              ? parsed.registryServerId
              : undefined,
        };
      }
    } catch {
      return null;
    }
  }

  const legacyServerName = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacyServerName) {
    return null;
  }

  return {
    serverName: legacyServerName,
    displayName: legacyServerName,
    sourceTab: "registry",
    createdAt: Date.now(),
  };
}

export function writePendingQuickConnect(
  state: PendingQuickConnectState,
): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearPendingQuickConnect(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}
