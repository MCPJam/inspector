/**
 * Per-turn reuse on the harness MCP proxy, on only with
 * `MCPJAM_HARNESS_MCP_TURN_CACHE=1` (read per call).
 *
 * A harness client opens its MCP connection with a burst of discovery requests
 * (handshake, lists), each of which would otherwise rebuild an authorized
 * upstream connection. Within one turn the authorized connection is reused by
 * the turn's later requests and disconnected once the turn has been idle for
 * 20 s. Every request still checks its live turn, as without reuse; a
 * request that found the connection already built is told so, since it
 * waited for nothing after that check.
 *
 * Keys name the user, project, server and turn, so nothing crosses a turn.
 */
import type { MCPClientManager } from "@mcpjam/sdk";

export function harnessMcpTurnCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_MCP_TURN_CACHE === "1";
}

const MANAGER_IDLE_MS = 20_000;
const MAX_ENTRIES = 200;

type Entry = {
  manager: Promise<MCPClientManager>;
  users: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** The connection has been built. */
  ready: boolean;
};

/** How a request came by its connection. */
export type TurnConnection = {
  /** Already built: the request waited for nothing to get it. */
  reused: boolean;
};

const managers = new Map<string, Entry>();

function retire(key: string, entry: Entry): void {
  if (managers.get(key) === entry) managers.delete(key);
  void entry.manager.then(
    (manager) => manager.disconnectAllServers(),
    () => undefined,
  );
}

/**
 * Run `fn` on the turn's authorized connection, creating it on first use.
 * A connection that fails to build is not kept.
 */
export async function withTurnManager<T>(
  key: string,
  create: () => Promise<MCPClientManager>,
  fn: (manager: MCPClientManager, connection: TurnConnection) => Promise<T>,
): Promise<T> {
  let entry = managers.get(key);
  if (!entry) {
    const created: Entry = {
      manager: create(),
      users: 0,
      idle: undefined,
      ready: false,
    };
    // A failed build is dropped below, where it is awaited.
    created.manager.then(
      () => {
        created.ready = true;
      },
      () => undefined,
    );
    entry = created;
    managers.set(key, entry);
    if (managers.size > MAX_ENTRIES) {
      const [oldestKey, oldest] = managers.entries().next().value as [string, Entry];
      if (oldest.users === 0) {
        if (oldest.idle) clearTimeout(oldest.idle);
        retire(oldestKey, oldest);
      }
    }
  }
  const held = entry;
  const reused = held.ready;
  if (held.idle) clearTimeout(held.idle);
  held.idle = undefined;
  held.users += 1;
  try {
    const manager = await held.manager.catch((error: unknown) => {
      if (managers.get(key) === held) managers.delete(key);
      throw error;
    });
    return await fn(manager, { reused });
  } finally {
    held.users -= 1;
    if (held.users === 0 && managers.get(key) === held) {
      held.idle = setTimeout(() => retire(key, held), MANAGER_IDLE_MS);
      held.idle.unref?.();
    }
  }
}

/** Test seam: forget every reused connection. */
export function resetHarnessMcpTurnCache(): void {
  for (const [key, entry] of managers) {
    if (entry.idle) clearTimeout(entry.idle);
    retire(key, entry);
  }
}
