/**
 * Per-turn reuse on the harness MCP proxy, on only with
 * `MCPJAM_HARNESS_MCP_TURN_CACHE=1` (read per call).
 *
 * A harness client opens its MCP connection with a burst of discovery requests
 * (handshake, lists), each of which would otherwise re-check its turn with the
 * backend and rebuild an authorized upstream connection. Within one turn:
 *
 * - a passed turn check is reused for 2 s, by discovery requests only; a tool
 *   call always checks its turn before, during and after, as before;
 * - the authorized connection is reused by the turn's later requests and
 *   disconnected once the turn has been idle for 20 s.
 *
 * Keys name the user, project, server and turn, so nothing crosses a turn.
 */
import type { MCPClientManager } from "@mcpjam/sdk";

export function harnessMcpTurnCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_MCP_TURN_CACHE === "1";
}

const CHECK_REUSE_MS = 2_000;
const MANAGER_IDLE_MS = 20_000;
const MAX_ENTRIES = 200;

const passedChecks = new Map<string, number>();

/** Run `check`, or reuse a pass for the same turn from the last 2 s. */
export async function checkTurnWithReuse(
  key: string,
  check: () => Promise<Response | undefined>,
  now: () => number = Date.now,
): Promise<Response | undefined> {
  const passedAt = passedChecks.get(key);
  if (passedAt !== undefined && now() - passedAt < CHECK_REUSE_MS) return undefined;
  const denied = await check();
  if (denied) {
    passedChecks.delete(key);
    return denied;
  }
  passedChecks.set(key, now());
  if (passedChecks.size > MAX_ENTRIES) {
    const oldest = passedChecks.keys().next().value;
    if (oldest !== undefined) passedChecks.delete(oldest);
  }
  return undefined;
}

type Entry = {
  manager: Promise<MCPClientManager>;
  users: number;
  idle: ReturnType<typeof setTimeout> | undefined;
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
  fn: (manager: MCPClientManager) => Promise<T>,
): Promise<T> {
  let entry = managers.get(key);
  if (!entry) {
    entry = { manager: create(), users: 0, idle: undefined };
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
  if (held.idle) clearTimeout(held.idle);
  held.idle = undefined;
  held.users += 1;
  try {
    const manager = await held.manager.catch((error: unknown) => {
      if (managers.get(key) === held) managers.delete(key);
      throw error;
    });
    return await fn(manager);
  } finally {
    held.users -= 1;
    if (held.users === 0 && managers.get(key) === held) {
      held.idle = setTimeout(() => retire(key, held), MANAGER_IDLE_MS);
      held.idle.unref?.();
    }
  }
}

/** Test seam: forget every reused check and connection. */
export function resetHarnessMcpTurnCache(): void {
  passedChecks.clear();
  for (const [key, entry] of managers) {
    if (entry.idle) clearTimeout(entry.idle);
    retire(key, entry);
  }
}
