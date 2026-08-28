/**
 * The daemon's real at-most-once command queue.
 *
 * `computerCommands` in Convex is only a post-hoc, best-effort log (see
 * `run-command.ts`), so the actual at-most-once guarantee has to live HERE, in
 * the process that drives the browser. The rules, from the plan:
 *
 *   1. Unseen commandId  → claim it, execute on the command's per-queue FIFO
 *      (one queue per tab serializes manual + chat + inspector + eval traffic;
 *      whole-session commands share one queue). At the depth cap → `busy` (429).
 *   2. Duplicate WHILE running → attach to the in-flight promise. One execution,
 *      both callers get the same NORMALIZED result — even if the executor throws.
 *   3. Duplicate AFTER settle → return the recorded result (no re-execution).
 *      Results are retained LRU `maxRetained` / TTL `retainTtlMs`; a cache hit
 *      refreshes recency, so eviction is genuinely least-recently-USED.
 *   4. Duplicate after the result was EVICTED → `expired` (409). Never re-run:
 *      the caller must treat the original outcome as unknown.
 *
 * bootId staleness (a commandId replayed against a *different* daemon boot) is
 * handled one layer up, at the HTTP boundary, before a command reaches this
 * queue — a fresh boot has a fresh queue with no memory of the old id, so the
 * daemon compares the caller's expected bootId to its own and rejects a mismatch
 * as `command_unknown_boot`. This queue is per-boot by construction.
 */
import {
  BrowserCommand,
  BrowserCommandOutcome,
  BrowserCommandResult,
  CommandQueueOptions,
  DEFAULT_COMMAND_QUEUE_OPTIONS,
} from "../protocol";

/**
 * Executes one command against the real browser. The queue owns ordering and
 * de-duplication; the executor owns the Chromium/CDP work. Injected so the queue
 * is testable with a fake driver, the way `run-command.ts` injects `BashRunner`.
 */
export type CommandExecutor = (
  command: BrowserCommand,
) => Promise<BrowserCommandResult>;

/** Which FIFO a command belongs to: its tab, or the session if tab-less. */
function queueKeyFor(command: BrowserCommand): string {
  return command.tabId ?? "@session";
}

function normalizeError(err: unknown): BrowserCommandResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

interface RunningEntry {
  state: "running";
  /** Never rejects: an executor throw is normalized to `{ok:false}` here, so a
   * duplicate awaiting this promise gets the same result as the first caller. */
  promise: Promise<BrowserCommandResult>;
}
interface SettledEntry {
  state: "settled";
  result: BrowserCommandResult;
  settledAt: number;
}
type CommandEntry = RunningEntry | SettledEntry;

export class CommandQueue {
  private readonly executor: CommandExecutor;
  private readonly bootId: string;
  private readonly maxRetained: number;
  private readonly retainTtlMs: number;
  private readonly perQueueDepthCap: number;
  private readonly now: () => number;

  /** commandId → its running promise or settled result. */
  private readonly commands = new Map<string, CommandEntry>();
  /** Insertion/access-ordered commandIds of SETTLED entries, for LRU eviction. */
  private readonly settledOrder: string[] = [];
  /** commandIds whose settled result was evicted (LRU/TTL): duplicates → expired.
   * Bounded (see `tombstone`) so a long-lived daemon cannot leak memory. */
  private readonly evicted = new Set<string>();
  /** Insertion-ordered tombstones, for bounding `evicted`. */
  private readonly evictedOrder: string[] = [];
  /** queueKey → tail of that FIFO, so the next command chains after it. */
  private readonly tails = new Map<string, Promise<unknown>>();
  /** queueKey → count of in-flight + queued commands, for the depth cap. */
  private readonly depth = new Map<string, number>();

  constructor(
    executor: CommandExecutor,
    bootId: string,
    options: CommandQueueOptions = {},
  ) {
    this.executor = executor;
    this.bootId = bootId;
    this.maxRetained =
      options.maxRetained ?? DEFAULT_COMMAND_QUEUE_OPTIONS.maxRetained;
    this.retainTtlMs =
      options.retainTtlMs ?? DEFAULT_COMMAND_QUEUE_OPTIONS.retainTtlMs;
    this.perQueueDepthCap =
      options.perQueueDepthCap ?? DEFAULT_COMMAND_QUEUE_OPTIONS.perQueueDepthCap;
    this.now = options.now ?? Date.now;

    // Reject nonsensical limits up front: e.g. `maxRetained: -1` would make
    // `settle` loop forever (`0 > -1`), blocking the daemon event loop.
    if (!Number.isInteger(this.maxRetained) || this.maxRetained < 0) {
      throw new RangeError(`maxRetained must be an integer >= 0, got ${this.maxRetained}`);
    }
    if (!Number.isInteger(this.perQueueDepthCap) || this.perQueueDepthCap < 1) {
      throw new RangeError(`perQueueDepthCap must be an integer >= 1, got ${this.perQueueDepthCap}`);
    }
    if (!Number.isFinite(this.retainTtlMs) || this.retainTtlMs < 0) {
      throw new RangeError(`retainTtlMs must be a finite number >= 0, got ${this.retainTtlMs}`);
    }
  }

  async submit(command: BrowserCommand): Promise<BrowserCommandOutcome> {
    const existing = this.lookup(command.commandId);
    if (existing) {
      // Rules 2 & 3: de-duplicate to the one execution. The running promise is
      // pre-normalized, so awaiting it here can never reject.
      const result =
        existing.state === "running" ? await existing.promise : existing.result;
      return { status: "ok", result, bootId: this.bootId };
    }

    // Rule 4: a commandId we retained a result for and then evicted is NOT safe
    // to re-run — its outcome is unknowable.
    if (this.evicted.has(command.commandId)) {
      return { status: "expired", bootId: this.bootId };
    }

    const key = queueKeyFor(command);
    if ((this.depth.get(key) ?? 0) >= this.perQueueDepthCap) {
      // Rule 1: per-tab queue is saturated. Reject without touching the map, so
      // the same commandId can be retried once the queue drains.
      return { status: "busy", bootId: this.bootId };
    }

    // Rule 1: claim the id, then chain execution onto the per-queue FIFO so
    // commands on the same tab run in order while different tabs run concurrently.
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1);
    const prior = this.tails.get(key) ?? Promise.resolve();
    const raw = prior
      .catch(() => undefined) // a prior command's failure must not stall the tab
      .then(() => this.executor(command));
    this.tails.set(key, raw);
    // The shared promise both the first caller and any duplicate await. It
    // resolves to a normalized result and NEVER rejects, so an executor throw
    // yields the same `{ok:false}` outcome for everyone (rule 2).
    const normalized = raw.then((r) => r, normalizeError);
    this.commands.set(command.commandId, { state: "running", promise: normalized });

    let result: BrowserCommandResult;
    try {
      result = await normalized;
    } finally {
      this.depth.set(key, (this.depth.get(key) ?? 1) - 1);
      if (this.tails.get(key) === raw) this.tails.delete(key);
    }

    this.settle(command.commandId, result);
    return { status: "ok", result, bootId: this.bootId };
  }

  /** Current retained-result count. Exposed for tests. */
  get retainedCount(): number {
    return this.settledOrder.length;
  }

  /** Current tombstone count. Exposed for tests; bounded by `maxRetained`. */
  get tombstoneCount(): number {
    return this.evicted.size;
  }

  private lookup(commandId: string): CommandEntry | undefined {
    const entry = this.commands.get(commandId);
    if (!entry) return undefined;
    if (entry.state === "running") return entry;
    if (this.now() - entry.settledAt > this.retainTtlMs) {
      // Rule 4 (TTL arm): the result aged out. Drop it and tombstone the id so a
      // duplicate is reported `expired`, never re-executed.
      this.dropSettled(commandId);
      this.tombstone(commandId);
      return undefined;
    }
    // Rule 3: a cache hit refreshes recency so eviction is truly least-recently
    // USED, not merely oldest-settled.
    this.touchRecency(commandId);
    return entry;
  }

  private settle(commandId: string, result: BrowserCommandResult): void {
    this.commands.set(commandId, {
      state: "settled",
      result,
      settledAt: this.now(),
    });
    this.settledOrder.push(commandId);
    while (this.settledOrder.length > this.maxRetained) {
      // Rule 4 (LRU arm): evict the least-recently-used settled result.
      const evictedId = this.settledOrder.shift()!;
      this.commands.delete(evictedId);
      this.tombstone(evictedId);
    }
  }

  private touchRecency(commandId: string): void {
    const idx = this.settledOrder.indexOf(commandId);
    if (idx !== -1) {
      this.settledOrder.splice(idx, 1);
      this.settledOrder.push(commandId);
    }
  }

  private dropSettled(commandId: string): void {
    this.commands.delete(commandId);
    const idx = this.settledOrder.indexOf(commandId);
    if (idx !== -1) this.settledOrder.splice(idx, 1);
  }

  /**
   * Record a tombstone, keeping the set bounded by `maxRetained`. Unbounded
   * tombstones would leak memory in a long-lived daemon. The tradeoff of the
   * bound: once the OLDEST tombstone is dropped, a replay of that ancient
   * commandId would be treated as unseen and re-run — acceptable because a
   * realistic retry arrives within seconds (far inside the retained window), and
   * cross-boot replays are already caught by the bootId check at the HTTP layer.
   */
  private tombstone(commandId: string): void {
    if (this.evicted.has(commandId)) return;
    this.evicted.add(commandId);
    this.evictedOrder.push(commandId);
    while (this.evictedOrder.length > this.maxRetained) {
      this.evicted.delete(this.evictedOrder.shift()!);
    }
  }
}
