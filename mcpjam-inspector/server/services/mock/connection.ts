/**
 * The mock's connection to its real server, kept between requests.
 *
 * One pool, the plugin host's `PluginConnectionPool`, so the lease rules and
 * the idle close are that pool's. The key is its own (actor, project, server,
 * client profile) plus the mock and its version. Two callers never share a
 * connection: the actor is a digest of who they are and what they sent, and
 * each connection is opened with that caller's own credentials.
 *
 * A lease serves one request at a time. A request that finds the connection
 * held waits briefly, then opens its own; whichever returns last replaces the
 * idle one.
 */
import type { MCPClientManager, MCPServerConfig } from "@mcpjam/sdk";
import { createAuthorizedManager, type ManagerCallerContext } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { pluginBindingDigest } from "../plugin-host/bindings.js";
import { PluginConnectionPool } from "../plugin-host/connection-pool.js";
import { rpcLogBus } from "../rpc-log-bus.js";
import { actorDigest, type ResolvedMock } from "./backend.js";
import type { MockDialProfile } from "./registry.js";
import { realServerOn, type PooledRealServer } from "./real-server.js";

/** How long a request waits for the connection another request holds. */
const LEASE_WAIT_MS = 300;

export const mockConnectionPool = new PluginConnectionPool();

export interface OpenedReal {
  manager: MCPClientManager;
  /** The authorized config to connect with; the manager is lazy and holds none. */
  config: MCPServerConfig;
  /** What the backend authorized, hashed to tell a changed server from the same one. */
  identity: unknown;
}

export type OpenReal = (args: {
  resolved: ResolvedMock;
  caller: ManagerCallerContext;
  bearerToken: string;
  profile: MockDialProfile;
}) => Promise<OpenedReal>;

/**
 * Opens the real server as the caller. Its traffic goes on the RPC log bus
 * under a scope of its own (`mock:<id>`), so it is the mock's and is not
 * mistaken for the member's own connection to that server: views that read
 * the bus without a scope never list it.
 */
export const openAuthorizedReal: OpenReal = async ({ resolved, caller, bearerToken, profile }) => {
  const id = resolved.baseServerId as string;
  const result = await createAuthorizedManager(
    caller,
    bearerToken,
    resolved.projectId,
    [id],
    profile.timeoutMs,
    undefined,
    profile.clientCapabilities,
    {
      lazyConnect: true,
      pluginComputerRuntime: false,
      initializePins: profile.initializePins,
      xaaIssuer: profile.xaaIssuer,
      rpcLogger: ({ direction, message, serverId }) =>
        rpcLogBus.publish({
          scopeId: `mock:${resolved.mockId}`,
          serverId,
          direction,
          timestamp: new Date().toISOString(),
          message,
        }),
    },
  );
  const config = result.authorizedServerConfigs?.[id];
  if (!config) {
    await closeUnused(result.manager);
    throw new Error("The real server was not authorized for this caller.");
  }
  return { manager: result.manager, config, identity: result.authorizedServerIdentities?.[id] };
};

/** Closes a connection nobody will use; a failure to close is logged, never raised. */
async function closeUnused(manager: Pick<MCPClientManager, "disconnectAllServers">) {
  try {
    await manager.disconnectAllServers();
  } catch (error) {
    logger.debug("[mock-route] closing an unused connection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function digestIdentity(identity: unknown): string {
  try {
    return pluginBindingDigest(identity ?? null);
  } catch {
    // An identity that cannot be hashed never matches, so the session is replaced.
    return `unhashable:${Math.random()}`;
  }
}

export interface MockLease {
  real: PooledRealServer;
  /** Ends the lease; the connection stays only if it is still up. Safe to call twice. */
  release(): Promise<void>;
  /** Ends the lease and closes the connection, after a failure. */
  discard(): Promise<void>;
}

export async function leaseRealServer(args: {
  resolved: ResolvedMock;
  caller: ManagerCallerContext;
  bearerToken: string;
  profile: MockDialProfile;
  signal: AbortSignal;
  open?: OpenReal;
}): Promise<MockLease> {
  const { resolved, profile } = args;
  const id = resolved.baseServerId as string;
  const pool = mockConnectionPool;
  const key = pluginBindingDigest([
    "mock-connection-v1",
    actorDigest(args.caller, args.bearerToken),
    resolved.projectId,
    resolved.mockId,
    resolved.version,
    id,
    pluginBindingDigest(profile),
  ]);
  const lessee = {};
  let entry = await pool.acquireWithin<MCPClientManager>(key, lessee, LEASE_WAIT_MS, args.signal);
  if (!entry || !pool.authorized(entry)) {
    // Inside the window the connection stands as it is. Past it the caller's
    // access is checked again in full, and the session is kept only if the
    // real server it was opened against is unchanged.
    const created = await (args.open ?? openAuthorizedReal)(args);
    const bindingId = digestIdentity(created.identity);
    if (entry && entry.bindingId === bindingId && entry.manager.getConnectionStatus(id) === "connected") {
      await closeUnused(created.manager);
      pool.reauthorized(entry, bindingId, bindingId);
    } else {
      if (entry) await pool.release(entry, lessee, false);
      try {
        await created.manager.connectToServer(id, created.config, { signal: args.signal });
      } catch (error) {
        await closeUnused(created.manager);
        throw error;
      }
      entry = pool.adopt(
        { key, serverId: id, manager: created.manager, hooks: {}, target: bindingId, bindingId },
        lessee,
      );
    }
  }
  const held = entry;
  let done = false;
  const end = async (reusable: boolean) => {
    if (done) return;
    done = true;
    try {
      await pool.release(held, lessee, reusable && held.manager.getConnectionStatus(id) === "connected");
    } catch (error) {
      logger.warn("[mock-route] returning a connection to the pool failed", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  };
  return {
    real: realServerOn(held.manager, id),
    release: () => end(true),
    discard: () => end(false),
  };
}
