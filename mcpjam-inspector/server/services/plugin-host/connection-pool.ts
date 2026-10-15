import type { MCPClientManager } from "@mcpjam/sdk";
import { pluginBindingDigest } from "./bindings.js";

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
  /** A background re-authorization is running (see `beginRefresh`). */
  refreshing?: boolean;
  lessee?: object;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

/** How long a request waits for its App's connection while another request
 * of the same actor and binding holds it (`acquireWithin`). About the rest of
 * an activation once the App's own first call needs the connection; well
 * under one full target authorization and MCP initialize (0.5-1 s). */
export const PLUGIN_CONNECTION_WAIT_MS = 300;

/** What one full target authorization found: the fields `reauthorized` sets. */
export interface PluginConnectionAuthorization {
  target: unknown;
  bindingId: string;
  transport?: string;
}

/**
 * Short-lived reuse of an authorized MCP connection across requests.
 *
 * Keyed by actor, project, host, server, host revision, saved server identity
 * and advertised capabilities (never shared between users or hosts). Leases
 * are exclusive: a connection serves one request at a time, and a request
 * that finds it held waits briefly for it (`acquireWithin`). Within the
 * authorization window a request skips the target re-authorization and MCP
 * initialize but still performs its own batched admission reads; after the
 * window the next request re-runs full target authorization and keeps the live
 * session only when the authorized target is unchanged. Idle connections close
 * after `idleMs`.
 *
 * A connection in active use is re-authorized AHEAD of that window: a request
 * that leases it once `refreshAfterMs` have passed starts the same full target
 * authorization in the background (`beginRefresh`/`endRefresh`), so an App
 * used at least every `authorizationWindowMs - refreshAfterMs` never pays it
 * inline. Staleness keeps the same bound: no request uses an authorization
 * older than `authorizationWindowMs`, and a refresh that finds the target or
 * binding changed (or fails) ends the window at once, so the next request
 * authorizes in full and replaces the session as before.
 */
export class PluginConnectionPool {
  private readonly idle = new Map<string, PooledPluginConnection>();
  /** Entries per key that a request holds right now. */
  private readonly leased = new Map<string, number>();
  /** Requests waiting for a leased entry of a key to come back. */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    readonly authorizationWindowMs = 60_000,
    readonly idleMs = 60_000,
    private readonly capacity = 64,
    readonly refreshAfterMs = 30_000,
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
    this.lease(key);
    return entry as PooledPluginConnection<M>;
  }

  /**
   * `acquire`, but when another request holds this key's connection right
   * now, wait up to `waitMs` for it to come back before giving up. Leases
   * stay exclusive (form requests route to one request); this only lets a
   * request that arrives while the same App's other request finishes (an App's
   * first call during its activation) take that connection, instead of
   * running a full target authorization and MCP initialize of its own.
   */
  async acquireWithin<M extends Manager>(
    key: string,
    lessee: object,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<PooledPluginConnection<M> | undefined> {
    const started = performance.now();
    for (;;) {
      const entry = this.acquire<M>(key, lessee);
      if (entry) return entry;
      const remaining = waitMs - (performance.now() - started);
      if (!this.leased.get(key) || remaining <= 0 || signal.aborted)
        return undefined;
      await this.released(key, remaining, signal);
    }
  }

  private lease(key: string) {
    this.leased.set(key, (this.leased.get(key) ?? 0) + 1);
  }
  private unlease(key: string) {
    const count = (this.leased.get(key) ?? 0) - 1;
    if (count > 0) this.leased.set(key, count);
    else this.leased.delete(key);
  }
  /** Resolves when a lease of `key` ends, the wait runs out, or `signal` aborts. */
  private released(key: string, ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      let waiting = this.waiters.get(key);
      if (!waiting) this.waiters.set(key, (waiting = new Set()));
      const set = waiting;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        set.delete(done);
        if (!set.size && this.waiters.get(key) === set)
          this.waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }

  /** Register a newly authorized connection, leased by `lessee`. */
  adopt<M extends Manager>(
    input: Omit<
      PooledPluginConnection<M>,
      "lessee" | "closed" | "idleTimer" | "authorizedAt"
    >,
    lessee: object,
  ): PooledPluginConnection<M> {
    this.lease(input.key);
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

  /** Called by a request that just leased `entry` without re-authorizing it.
   * Returns the start time when that request should re-run full target
   * authorization in the background (once per entry at a time); otherwise
   * undefined. */
  beginRefresh(entry: PooledPluginConnection): number | undefined {
    if (entry.refreshing || !this.authorized(entry)) return undefined;
    const now = this.now();
    if (now - entry.authorizedAt < this.refreshAfterMs) return undefined;
    entry.refreshing = true;
    return now;
  }

  /** A background authorization begun at `startedAt` finished. The same
   * target, binding and transport extend the window from when it started;
   * anything else (changed, refused, failed) ends the window now, so the next
   * request runs full authorization inline. A newer full authorization of
   * this entry always wins. */
  endRefresh(
    entry: PooledPluginConnection,
    startedAt: number,
    authorization: PluginConnectionAuthorization | undefined,
  ) {
    entry.refreshing = false;
    if (entry.closed || entry.authorizedAt > startedAt) return;
    const unchanged =
      !!authorization &&
      authorization.bindingId === entry.bindingId &&
      authorization.transport === entry.transport &&
      sameTarget(authorization.target, entry.target);
    entry.authorizedAt = unchanged ? startedAt : Number.NEGATIVE_INFINITY;
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
    this.unlease(entry.key);
    if (
      !reusable ||
      entry.closed ||
      entry.manager.getConnectionStatus(entry.serverId) !== "connected"
    ) {
      // A waiter stops waiting for it and authorizes its own.
      this.wake(entry.key);
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
    this.wake(entry.key);
  }

  private wake(key: string) {
    for (const done of [...(this.waiters.get(key) ?? [])]) done();
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

/** Canonical comparison of two authorized targets; an absent one never matches. */
function sameTarget(a: unknown, b: unknown) {
  try {
    return pluginBindingDigest(a) === pluginBindingDigest(b);
  } catch {
    return false;
  }
}

export const pluginConnectionPool = new PluginConnectionPool();
