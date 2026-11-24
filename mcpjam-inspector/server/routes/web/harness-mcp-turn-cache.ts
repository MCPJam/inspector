/**
 * Per-turn reuse on the harness MCP proxy.
 *
 * A harness client opens its MCP connection with a burst of discovery requests
 * (handshake, lists), each of which would otherwise rebuild an authorized
 * upstream connection. Within one turn the authorized connection is reused by
 * the turn's later requests and disconnected once the turn has been idle for
 * 20 s. Reuse changes no check: every request is still checked against its
 * live turn once its body is read, before it runs, and after the call.
 *
 * The next request builds the connection again after one that failed (its
 * upstream session may be gone) and after a change the server announced on a
 * relayed listen: the reused client would otherwise answer lists from a cache
 * that change made stale.
 *
 * Keys name the user, project, server and turn, so nothing crosses a turn.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";

const MANAGER_IDLE_MS = 20_000;
const MAX_ENTRIES = 200;

type Entry = {
  manager: Promise<MCPClientManager>;
  users: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** No longer handed out: disconnected once no request holds it. */
  discarded: boolean;
};

/** What a request can do about the turn's connection. */
export type TurnConnection = {
  /** Have the next request build the connection again. */
  discard(): void;
};

const managers = new Map<string, Entry>();

function disconnect(entry: Entry): void {
  void entry.manager
    .then((manager) => manager.disconnectAllServers())
    .catch((error: unknown) => {
      // A connection that failed to build was already reported to the
      // request that built it; a failed disconnect has nothing left to undo.
      logger.debug("[harness-mcp] turn connection: retire failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    });
}

/** Stop handing `entry` out, and disconnect it once no request holds it. */
function discard(key: string, entry: Entry): void {
  if (entry.discarded) return;
  entry.discarded = true;
  if (managers.get(key) === entry) managers.delete(key);
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = undefined;
  if (entry.users === 0) disconnect(entry);
}

/** Have the turn's next request build its connection again. */
export function discardTurnManager(key: string): void {
  const entry = managers.get(key);
  if (entry) discard(key, entry);
}

/**
 * Run `fn` on the turn's authorized connection, creating it on first use.
 * A connection that fails to build is not kept, and one whose request threw
 * is built again by the next request.
 */
export async function withTurnManager<T>(
  key: string,
  create: () => Promise<MCPClientManager>,
  fn: (manager: MCPClientManager, connection: TurnConnection) => Promise<T>,
): Promise<T> {
  let entry = managers.get(key);
  if (!entry) {
    entry = { manager: create(), users: 0, idle: undefined, discarded: false };
    managers.set(key, entry);
    if (managers.size > MAX_ENTRIES) {
      const [oldestKey, oldest] = managers.entries().next().value as [string, Entry];
      if (oldest.users === 0) discard(oldestKey, oldest);
    }
  }
  const held = entry;
  if (held.idle) clearTimeout(held.idle);
  held.idle = undefined;
  held.users += 1;
  let built = false;
  try {
    const manager = await held.manager.catch((error: unknown) => {
      held.discarded = true;
      if (managers.get(key) === held) managers.delete(key);
      throw error;
    });
    built = true;
    return await fn(manager, { discard: () => discard(key, held) });
  } catch (error) {
    if (built) discard(key, held);
    throw error;
  } finally {
    held.users -= 1;
    if (held.users === 0) {
      if (held.discarded) {
        if (built) disconnect(held);
      } else if (managers.get(key) === held) {
        held.idle = setTimeout(() => discard(key, held), MANAGER_IDLE_MS);
        held.idle.unref?.();
      }
    }
  }
}

/** Test seam: forget every reused connection. */
export function resetHarnessMcpTurnCache(): void {
  for (const [key, entry] of managers) discard(key, entry);
}
