import type { MCPClientManager } from "@mcpjam/sdk";

/** Per-lease form services. The pooled connection's server-request handlers
 * dispatch to whichever request currently holds the lease, and refuse when
 * none does; a connection never routes one request's forms to another. */
export interface PluginConnectionHooks {
  legacy?: (request: { params?: Record<string, unknown> }) => Promise<unknown>;
  collector?: (args: never) => Promise<unknown>;
}

type Manager = Pick<
  MCPClientManager,
  "disconnectAllServers" | "getConnectionStatus"
>;

export interface PooledPluginConnection<M extends Manager = Manager> {
  readonly key: string;
  readonly serverId: string;
  readonly manager: M;
  readonly hooks: PluginConnectionHooks;
  /** The authorized target config and credential-free binding fingerprint from
   * the last FULL target authorization. */
  target: unknown;
  bindingId: string;
  /** The saved server's transport ("stdio" runs on the project's Computer
   * when hosted), from the same full authorization. */
  transport?: string;
  authorizedAt: number;
  lessee?: object;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

/**
 * Short-lived reuse of an authorized MCP connection across requests.
 *
 * Keyed by actor, project, host, server, host revision, saved server identity
 * and advertised capabilities (never shared between users or hosts). Leases
 * are exclusive: a connection serves one request at a time. Within the
 * authorization window a request skips the target re-authorization and MCP
 * initialize but still performs its own batched admission reads; after the
 * window the next request re-runs full target authorization and keeps the live
 * session only when the authorized target is unchanged. Idle connections close
 * after `idleMs`.
 */
export class PluginConnectionPool {
  private readonly idle = new Map<string, PooledPluginConnection>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    readonly authorizationWindowMs = 60_000,
    readonly idleMs = 60_000,
    private readonly capacity = 64,
  ) {}

  /** An idle, connected entry for `key`, now exclusively leased; else none. */
  acquire<M extends Manager>(
    key: string,
    lessee: object,
  ): PooledPluginConnection<M> | undefined {
    const entry = this.idle.get(key);
    if (!entry) return undefined;
    this.idle.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    if (
      entry.closed ||
      entry.manager.getConnectionStatus(entry.serverId) !== "connected"
    ) {
      void this.close(entry);
      return undefined;
    }
    entry.lessee = lessee;
    return entry as PooledPluginConnection<M>;
  }

  /** Register a newly authorized connection, leased by `lessee`. */
  adopt<M extends Manager>(
    input: Omit<
      PooledPluginConnection<M>,
      "lessee" | "closed" | "idleTimer" | "authorizedAt"
    >,
    lessee: object,
  ): PooledPluginConnection<M> {
    return {
      ...input,
      authorizedAt: this.now(),
      lessee,
      closed: false,
    };
  }

  /** True while a request may skip full target re-authorization. */
  authorized(entry: PooledPluginConnection) {
    return (
      !entry.closed &&
      this.now() - entry.authorizedAt < this.authorizationWindowMs &&
      entry.manager.getConnectionStatus(entry.serverId) === "connected"
    );
  }

  /** A full target authorization just succeeded for this live session. */
  reauthorized(
    entry: PooledPluginConnection,
    target: unknown,
    bindingId: string,
    transport?: string,
  ) {
    entry.target = target;
    entry.bindingId = bindingId;
    entry.transport = transport;
    entry.authorizedAt = this.now();
  }

  /** End a lease. Reusable connected entries go idle; others close. */
  async release(
    entry: PooledPluginConnection,
    lessee: object,
    reusable: boolean,
  ) {
    if (entry.lessee !== lessee) return;
    entry.lessee = undefined;
    entry.hooks.legacy = undefined;
    entry.hooks.collector = undefined;
    if (
      !reusable ||
      entry.closed ||
      entry.manager.getConnectionStatus(entry.serverId) !== "connected"
    ) {
      await this.close(entry);
      return;
    }
    const previous = this.idle.get(entry.key);
    if (previous && previous !== entry) {
      this.idle.delete(entry.key);
      void this.close(previous);
    }
    this.idle.set(entry.key, entry);
    entry.idleTimer = setTimeout(() => {
      if (this.idle.get(entry.key) === entry) this.idle.delete(entry.key);
      void this.close(entry);
    }, this.idleMs);
    entry.idleTimer.unref?.();
    while (this.idle.size > this.capacity) {
      const [oldestKey, oldest] = this.idle.entries().next().value!;
      this.idle.delete(oldestKey);
      if (oldest.idleTimer) clearTimeout(oldest.idleTimer);
      void this.close(oldest);
    }
  }

  private async close(entry: PooledPluginConnection) {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      await entry.manager.disconnectAllServers();
    } catch {
      /* A failed disconnect never revives the entry. */
    }
  }

  get idleSize() {
    return this.idle.size;
  }

  /** Close every idle connection (tests, shutdown). */
  async clear() {
    const entries = [...this.idle.values()];
    this.idle.clear();
    await Promise.all(entries.map((entry) => this.close(entry)));
  }
}

export const pluginConnectionPool = new PluginConnectionPool();
