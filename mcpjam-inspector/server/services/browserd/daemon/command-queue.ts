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
  DEFAULT_QUEUE_KEY,
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
  return command.tabId ?? DEFAULT_QUEUE_KEY;
}

/**
 * Is this command safe to simply run again?
 *
 * At-most-once exists to protect SIDE EFFECTS: a click that submits a form, a
 * page tool that charges a card. An `observe` has none — it reads the page and
 * returns what it saw — so remembering its id buys nothing, and remembering it
 * FOREVER costs the one resource this queue rations.
 *
 * That cost is not theoretical. Every distinct id must be retained for the
 * whole boot, first as a result and then as a tombstone, against
 * `maxCommandsPerBoot`. The WebMCP inspector polls the page's tool list on an
 * interval for as long as somebody is watching it, which is thousands of
 * observations an hour — enough to exhaust a 50,000-command budget in a day
 * and leave the daemon answering `at_capacity` to everything, including the
 * commands that do have side effects. Exempting reads keeps the budget for
 * the commands whose duplicates actually matter.
 *
 * A duplicate observation therefore re-executes, which is the correct answer
 * for a read: it returns what the page looks like NOW, which is fresher than
 * what a cache would have said anyway.
 */
function isReplayable(command: BrowserCommand): boolean {
  return command.action.kind === "observe";
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
  private readonly maxCommandsPerBoot: number;
  private readonly now: () => number;

  /** commandId → its running promise or settled result. */
  private readonly commands = new Map<string, CommandEntry>();
  /** Insertion/access-ordered commandIds of SETTLED entries, for LRU eviction. */
  private readonly settledOrder: string[] = [];
  /** commandIds whose settled result was evicted (LRU/TTL): duplicates → expired.
   * Kept for the FULL boot — forgetting one would let a delayed retry re-run a
   * non-idempotent action. Growth is bounded by refusing new commands at
   * `maxCommandsPerBoot`, not by dropping tombstones. */
  private readonly evicted = new Set<string>();
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
      options.perQueueDepthCap ??
      DEFAULT_COMMAND_QUEUE_OPTIONS.perQueueDepthCap;
    this.maxCommandsPerBoot =
      options.maxCommandsPerBoot ??
      DEFAULT_COMMAND_QUEUE_OPTIONS.maxCommandsPerBoot;
    this.now = options.now ?? Date.now;

    // Reject nonsensical limits up front: e.g. `maxRetained: -1` would make
    // `settle` loop forever (`0 > -1`), blocking the daemon event loop.
    if (!Number.isInteger(this.maxRetained) || this.maxRetained < 0) {
      throw new RangeError(
        `maxRetained must be an integer >= 0, got ${this.maxRetained}`,
      );
    }
    if (!Number.isInteger(this.perQueueDepthCap) || this.perQueueDepthCap < 1) {
      throw new RangeError(
        `perQueueDepthCap must be an integer >= 1, got ${this.perQueueDepthCap}`,
      );
    }
    if (!Number.isFinite(this.retainTtlMs) || this.retainTtlMs < 0) {
      throw new RangeError(
        `retainTtlMs must be a finite number >= 0, got ${this.retainTtlMs}`,
      );
    }
    // The per-boot ceiling must admit at least the result cache, or a full cache
    // would wedge the daemon at capacity with no room for tombstones.
    if (
      !Number.isInteger(this.maxCommandsPerBoot) ||
      this.maxCommandsPerBoot < this.maxRetained
    ) {
      throw new RangeError(
        `maxCommandsPerBoot must be an integer >= maxRetained (${this.maxRetained}), got ${this.maxCommandsPerBoot}`,
      );
    }
  }

  async submit(command: BrowserCommand): Promise<BrowserCommandOutcome> {
    // Reads run on the FIFO like anything else — ordering still matters, and
    // the depth cap still applies — but they are never tracked by id, so they
    // spend no part of the per-boot budget. See `isReplayable`.
    if (isReplayable(command)) return this.runUntracked(command);

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

    // A genuinely NEW command adds one more id we must remember for the whole
    // boot (as a returnable result, then as a tombstone). At the ceiling we
    // refuse rather than forget a tombstone: forgetting one would let a delayed
    // retry re-run a non-idempotent action. The daemon should rotate.
    if (this.distinctTrackedCount >= this.maxCommandsPerBoot) {
      return { status: "at_capacity", bootId: this.bootId };
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
    this.commands.set(command.commandId, {
      state: "running",
      promise: normalized,
    });

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

  /**
   * Run a command without claiming its id: no result cache, no tombstone, no
   * charge against the per-boot ceiling. Still queued and still depth-capped,
   * so it cannot stampede the browser.
   */
  private async runUntracked(
    command: BrowserCommand,
  ): Promise<BrowserCommandOutcome> {
    const key = queueKeyFor(command);
    if ((this.depth.get(key) ?? 0) >= this.perQueueDepthCap) {
      return { status: "busy", bootId: this.bootId };
    }
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1);
    const prior = this.tails.get(key) ?? Promise.resolve();
    const raw = prior.catch(() => undefined).then(() => this.executor(command));
    this.tails.set(key, raw);
    try {
      const result = await raw.then((r) => r, normalizeError);
      return { status: "ok", result, bootId: this.bootId };
    } finally {
      this.depth.set(key, (this.depth.get(key) ?? 1) - 1);
      if (this.tails.get(key) === raw) this.tails.delete(key);
    }
  }

  /** Current retained-result count. Exposed for tests. */
  get retainedCount(): number {
    return this.settledOrder.length;
  }

  /** Current tombstone count. Exposed for tests. */
  get tombstoneCount(): number {
    return this.evicted.size;
  }

  /**
   * Distinct commandIds this boot is obligated to remember: live results/running
   * entries plus tombstones. Every distinct command contributes exactly one
   * (a settled result becomes a tombstone on eviction — one leaves `commands`,
   * one enters `evicted`), so this is monotonic and the memory ceiling.
   */
  private get distinctTrackedCount(): number {
    return this.commands.size + this.evicted.size;
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
   * Tombstone a commandId for the rest of the boot. Deliberately never dropped:
   * a delayed retry of any evicted id must return `expired`, never re-run. Total
   * tombstones are bounded because `submit` refuses NEW commands once
   * `distinctTrackedCount` reaches `maxCommandsPerBoot`.
   */
  private tombstone(commandId: string): void {
    this.evicted.add(commandId);
  }
}
