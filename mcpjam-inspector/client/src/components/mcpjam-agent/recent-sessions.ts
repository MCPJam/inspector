/**
 * Local registry of recent MCPJam Agent sessions.
 *
 * Stored client-side in `localStorage` so the "Recent chat" pill doesn't
 * need a server tagging field (avoids the closed-union `sourceType` /
 * `surface` cross-repo work for v1). Entries are an MRU stack capped at
 * `MAX_ENTRIES`.
 */

const STORAGE_KEY = "mcpjam:agent-recent-sessions";
const MAX_ENTRIES = 12;

export interface RecentMcpjamAgentSession {
  id: string;
  title: string;
  /** Unix ms of last interaction. */
  ts: number;
}

function isWindowAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function safeParse(raw: string | null): RecentMcpjamAgentSession[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentMcpjamAgentSession =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentMcpjamAgentSession).id === "string" &&
        typeof (entry as RecentMcpjamAgentSession).title === "string" &&
        typeof (entry as RecentMcpjamAgentSession).ts === "number"
    );
  } catch {
    return [];
  }
}

export function loadRecentMcpjamAgentSessions(): RecentMcpjamAgentSession[] {
  if (!isWindowAvailable()) return [];
  const list = safeParse(window.localStorage.getItem(STORAGE_KEY));
  // Sort newest first defensively — writers maintain order but a manual
  // edit shouldn't break the pill.
  return list.sort((a, b) => b.ts - a.ts);
}

const listeners = new Set<(value: RecentMcpjamAgentSession[]) => void>();

function notifyListeners(): void {
  const snapshot = loadRecentMcpjamAgentSessions();
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function appendRecentMcpjamAgentSession(
  entry: RecentMcpjamAgentSession
): void {
  if (!isWindowAvailable()) return;
  const existing = loadRecentMcpjamAgentSessions().filter(
    (s) => s.id !== entry.id
  );
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage quota / disabled — ignore. The pill just won't show.
    return;
  }
  notifyListeners();
}

export function subscribeMcpjamAgentSessions(
  listener: (value: RecentMcpjamAgentSession[]) => void
): () => void {
  listeners.add(listener);
  // Cross-tab updates via the native `storage` event.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      listener(loadRecentMcpjamAgentSessions());
    }
  };
  if (isWindowAvailable()) {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (isWindowAvailable()) {
      window.removeEventListener("storage", onStorage);
    }
  };
}
