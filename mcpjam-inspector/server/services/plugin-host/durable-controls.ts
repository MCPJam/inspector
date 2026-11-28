import type { DurablePluginInstanceControl } from "../../../shared/plugin-invocation-receipts.js";
import { pluginBindingDigest } from "./bindings.js";
import type {
  PluginInstanceAdmissionRead,
  PluginInstanceIdentity,
} from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import type { PluginInstanceControlPort } from "./instance-store.js";

const isCode = (error: unknown, ...codes: string[]) =>
  error instanceof PluginInvocationError && codes.includes(error.code);
/** Local closes are an optimization over the store's own closed rows. */
const CLOSED_TOMBSTONES = 4096;

/** One fenced read: the admission query, then the stored row, never side
 * by side. A close or expiry anywhere during the admission wait refuses what
 * follows, including the dispatch that authorization leads to. */
export async function readAfterAdmission<T>(
  query: () => Promise<T>,
  readControl: () => Promise<unknown>,
) {
  const admitted = await query();
  await readControl();
  return admitted;
}

/** What this process keeps for any restored control. The stored row is its
 * authority; everything here is rebuilt from it on any replica. */
export interface CachedControl {
  readonly snapshotHash: string;
  /** The lease as this process last read it from the store. */
  expiresAt: number;
  readonly abort: AbortController;
  eviction?: ReturnType<typeof setTimeout>;
}

/** How one kind of stored row becomes this process's entry. */
export interface DurableControlKind<Entry extends CachedControl, Snapshot> {
  /** The refusal a caller sees for anything this kind cannot serve. */
  denied(): PluginInvocationError;
  /** The row's snapshot, or undefined for another kind or a malformed row. */
  parse(saved: DurablePluginInstanceControl): Snapshot | undefined;
  /** The deadline the row was issued with; a stored lease only extends it. */
  issuedUntil(snapshot: Snapshot): number;
  /** Whether the stored owner is this caller. */
  owns(snapshot: Snapshot, actor: PluginInstanceIdentity): boolean;
  /** Whether this process's entry is this caller's, credential included. */
  matches(entry: Entry, actor: PluginInstanceIdentity): boolean;
  /** Build this process's entry from a live row; throwing refuses it.
   * `assertLive` checks the entry as this process last read it. */
  create(input: {
    token: string;
    actor: PluginInstanceIdentity;
    snapshot: Snapshot;
    saved: DurablePluginInstanceControl;
    snapshotHash: string;
    assertLive: () => void;
  }): Entry;
  /** Adopt a later read of a row this process already holds. */
  refresh?(entry: Entry, saved: DurablePluginInstanceControl): void;
  /** Runs after every successful restore. */
  restored?(entry: Entry): void;
  /** Release what the entry holds in this process; never the stored row. */
  release(entry: Entry): void;
  /** What a read may leave out because this process already holds it. */
  readHint?(entry: Entry): number | undefined;
  /** A refusal of a hinted read that a full read can fix. */
  retryFull?(error: unknown): boolean;
}

/**
 * Durable controls as this process uses them. A request reads the stored
 * row before it acts, and again after each admission wait (`fence`), so a
 * close or expiry on any replica refuses what follows. Nothing here closes a
 * row on a local timer: an entry this process stops using is dropped, never
 * closed, since another replica may have renewed it.
 */
export class DurableControlCache<Entry extends CachedControl, Snapshot> {
  private readonly entries = new Map<string, Entry>();
  private readonly closed = new Map<string, number>();

  constructor(
    private readonly kind: DurableControlKind<Entry, Snapshot>,
    private readonly options: {
      ttlMs: number;
      now: () => number;
      portFor: (
        identity: PluginInstanceIdentity,
      ) => PluginInstanceControlPort | undefined;
    },
  ) {}

  private now() {
    return this.options.now();
  }

  /** Whether this process knows `token` (open or closed). */
  holds(token: string) {
    return this.entries.has(token) || this.closed.has(token);
  }

  /** This process's entry, unchecked: only for code that just checked it. */
  peek(token: string) {
    return this.entries.get(token);
  }

  port(actor: PluginInstanceIdentity) {
    const port = this.options.portFor(actor);
    if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
    return port;
  }

  /** The stored row, restored into this process. */
  async restore(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
    port = this.port(actor),
  ) {
    signal.throwIfAborted();
    this.sweep();
    if (this.closed.has(token)) throw this.kind.denied();
    const held = this.entries.get(token);
    const known = held ? this.kind.readHint?.(held) : undefined;
    const read = async (hint?: number) => {
      try {
        return await port.read(token, signal, hint);
      } catch (error) {
        throw this.refusal(token, actor, error);
      }
    };
    try {
      return this.restoreFrom(token, actor, await read(known), signal);
    } catch (error) {
      if (known === undefined || !this.kind.retryFull?.(error)) throw error;
      return this.restoreFrom(token, actor, await read(), signal);
    }
  }

  /** Restore a row the caller already read. */
  restoreFrom(
    token: string,
    actor: PluginInstanceIdentity,
    saved: DurablePluginInstanceControl | null,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.sweep();
    if (this.closed.has(token)) throw this.kind.denied();
    // The store keys a row by identity and token, so no row means none for
    // this caller. Only the caller's own copy is dropped.
    if (!saved) {
      const own = this.entries.get(token);
      if (own && this.kind.matches(own, actor)) this.tombstone(token);
      throw this.kind.denied();
    }
    const snapshot = this.kind.parse(saved);
    if (snapshot === undefined || !this.kind.owns(snapshot, actor))
      throw this.kind.denied();
    const snapshotHash = pluginBindingDigest(saved.snapshotJson);
    let entry = this.entries.get(token);
    if (
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt < this.kind.issuedUntil(snapshot)
    )
      throw this.kind.denied();
    // A lease that ended in flight refuses this request, but proves no close:
    // this process may already hold a later renewal of the same row.
    if (
      saved.expiresAt <= this.now() &&
      (!entry || entry.snapshotHash !== snapshotHash)
    )
      throw this.kind.denied();
    if (entry) {
      this.get(token, actor);
      if (entry.snapshotHash !== snapshotHash) throw this.kind.denied();
      // A reply overtaken by a later renewal never shortens the lease.
      entry.expiresAt = Math.max(entry.expiresAt, saved.expiresAt);
      this.kind.refresh?.(entry, saved);
    } else {
      entry = this.kind.create({
        token,
        actor,
        snapshot,
        saved,
        snapshotHash,
        assertLive: () => {
          this.get(token, actor);
        },
      });
      this.entries.set(token, entry);
      this.evictAtLeaseEnd(token, entry);
    }
    this.kind.restored?.(entry);
    return entry;
  }

  /** Keep an entry for a row this process just issued, so its own requests
   * reuse what it built (such as an invoker holding in-process receipts). */
  adopt(token: string, entry: Entry) {
    if (this.entries.has(token)) return;
    this.closed.delete(token);
    this.entries.set(token, entry);
    this.evictAtLeaseEnd(token, entry);
  }

  /** This process's entry, checked against its last durable read only. Call
   * after `restore` or a `fence` read within the same request. */
  get(token: string, actor: PluginInstanceIdentity) {
    const entry = this.entries.get(token);
    if (
      !entry ||
      entry.abort.signal.aborted ||
      entry.expiresAt <= this.now() ||
      this.closed.has(token)
    ) {
      if (entry) this.drop(token);
      throw this.kind.denied();
    }
    if (!this.kind.matches(entry, actor)) throw this.kind.denied();
    return entry;
  }

  /** One fence: `query` (an admission read), then the stored row. The row is
   * read only after admission completes, so a close or expiry on any replica
   * during the admission wait refuses what follows the fence. */
  fence(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
  ): PluginInstanceAdmissionRead {
    return async (query) => {
      const admitted = await readAfterAdmission(query, () =>
        this.restore(token, actor, signal),
      );
      signal.throwIfAborted();
      this.get(token, actor);
      return admitted;
    };
  }

  /** A store refusal for this caller's own row (the store keys it by
   * identity) means the row is closed or expired everywhere. */
  refusal(token: string, actor: PluginInstanceIdentity, error: unknown) {
    if (isCode(error, "INSTANCE_DENIED")) return this.kind.denied();
    if (!isCode(error, "INSTANCE_UNAVAILABLE")) return error;
    const entry = this.entries.get(token);
    if (!entry || this.kind.matches(entry, actor)) this.tombstone(token);
    return this.kind.denied();
  }

  /** Close everywhere: the store refuses the token on every replica. */
  async close(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
  ) {
    const entry = this.entries.get(token);
    if (entry && !this.kind.matches(entry, actor)) throw this.kind.denied();
    const port = this.port(actor);
    // Stop this process's use at once; an unknown handle is tombstoned only
    // once the store confirms it was this caller's row.
    if (entry) this.tombstone(token);
    const closed = await port.close(token, signal);
    if (closed?.ownerHash) this.tombstone(token);
  }

  /** Release this process's copy once the lease it last read ends, even if
   * no request arrives. It drops, never closes. */
  private evictAtLeaseEnd(token: string, entry: Entry) {
    clearTimeout(entry.eviction);
    entry.eviction = setTimeout(
      () => {
        if (this.entries.get(token) !== entry) return;
        if (entry.expiresAt > this.now()) this.evictAtLeaseEnd(token, entry);
        else this.drop(token);
      },
      Math.max(0, entry.expiresAt - this.now()),
    );
    entry.eviction.unref?.();
  }

  /** Forget this process's copy; the stored row is untouched. */
  drop(token: string) {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    clearTimeout(entry.eviction);
    entry.abort.abort();
    this.kind.release(entry);
  }

  private tombstone(token: string) {
    this.drop(token);
    this.closed.delete(token);
    this.closed.set(token, this.now() + this.options.ttlMs);
    for (const key of this.closed.keys()) {
      if (this.closed.size <= CLOSED_TOMBSTONES) break;
      this.closed.delete(key);
    }
  }

  private sweep() {
    for (const [token, expiry] of this.closed)
      if (expiry <= this.now()) this.closed.delete(token);
    for (const [token, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.drop(token);
  }
}
