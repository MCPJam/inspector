/**
 * In-memory ring buffer of recent requests that arrived through an active
 * tunnel, keyed by serverId. Backs the recent-requests panel in the UI so
 * users can see what remote MCP clients are doing with their tunnel.
 *
 * Deliberately tiny and in-memory: entries die with the process, exactly
 * like the tunnel listener they describe.
 */

export interface TunnelRequestLogEntry {
  ts: number;
  method: string;
  path: string;
}

const MAX_ENTRIES_PER_SERVER = 50;

const buffers = new Map<string, TunnelRequestLogEntry[]>();

export function recordTunnelRequest(
  serverId: string,
  entry: { method?: string; path: string }
): void {
  const buffer = buffers.get(serverId) ?? [];
  buffer.unshift({
    ts: Date.now(),
    method: entry.method || "(notification)",
    path: entry.path,
  });
  if (buffer.length > MAX_ENTRIES_PER_SERVER) {
    buffer.length = MAX_ENTRIES_PER_SERVER;
  }
  buffers.set(serverId, buffer);
}

/** Newest-first list of recent tunneled requests for a server. */
export function getTunnelRequests(serverId: string): TunnelRequestLogEntry[] {
  return [...(buffers.get(serverId) ?? [])];
}

export function clearTunnelRequests(serverId: string): void {
  buffers.delete(serverId);
}
