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
 *      both callers get the same result.
 *   3. Duplicate AFTER settle → return the recorded result (no re-execution).
 *      Results are retained LRU `maxRetained` / TTL `retainTtlMs`.
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

interface RunningEntry {
  state: "running";
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
  /** Insertion-ordered commandIds of SETTLED entries, for LRU eviction. */
  private readonly settledOrder: string[] = [];
  /** queueKey → tail of that FIFO, so the next command chains after it. */
  private readonly tails = new Map<string, Promise<unknown>>();
  /** queueKey → count of in-flight + queued commands, for the depth cap. */
  private readonly depth = new Map<string, number>();
  /** commandIds whose settled result was evicted (LRU/TTL): duplicates → expired. */
  private readonly evicted = new Set<string>();

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
  }

  async submit(command: BrowserCommand): Promise<BrowserCommandOutcome> {
    const existing = this.lookup(command.commandId);
    if (existing) {
      // Rules 2 & 3: de-duplicate to the one execution.
      if (existing.state === "running") {
        return { status: "ok", result: await existing.promise, bootId: this.bootId };
      }
      return { status: "ok", result: existing.result, bootId: this.bootId };
    }

    // Rule 4: a commandId we retained the result for and then evicted is NOT
    // safe to re-run. lookup() only removes EXPIRED (TTL) settled entries;
    // eviction by LRU records a tombstone so a later duplicate is caught here.
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
    const run = prior
      .catch(() => undefined) // a prior command's failure must not stall the tab
      .then(() => this.executor(command));
    this.tails.set(key, run);
    this.commands.set(command.commandId, { state: "running", promise: run });

    let result: BrowserCommandResult;
    try {
      result = await run;
    } catch (err) {
      // The executor threw rather than returning {ok:false}; normalize so the
      // recorded outcome is a value, and a duplicate gets the same answer.
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.depth.set(key, (this.depth.get(key) ?? 1) - 1);
      if (this.tails.get(key) === run) this.tails.delete(key);
    }

    this.settle(command.commandId, result);
    return { status: "ok", result, bootId: this.bootId };
  }

  /** Current retained-result count. Exposed for tests. */
  get retainedCount(): number {
    return this.settledOrder.length;
  }

  private lookup(commandId: string): CommandEntry | undefined {
    const entry = this.commands.get(commandId);
    if (!entry) return undefined;
    if (entry.state === "running") return entry;
    if (this.now() - entry.settledAt > this.retainTtlMs) {
      // Rule 4 (TTL arm): the result aged out. Drop it and tombstone the id so a
      // duplicate is reported `expired`, never re-executed.
      this.dropSettled(commandId);
      this.evicted.add(commandId);
      return undefined;
    }
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
      // Rule 4 (LRU arm): evict the oldest settled result and tombstone it.
      const evictedId = this.settledOrder.shift()!;
      this.commands.delete(evictedId);
      this.evicted.add(evictedId);
    }
  }

  private dropSettled(commandId: string): void {
    this.commands.delete(commandId);
    const idx = this.settledOrder.indexOf(commandId);
    if (idx !== -1) this.settledOrder.splice(idx, 1);
  }
}
