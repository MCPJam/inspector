/**
 * Terminal driver for `mcpjam events watch`.
 *
 * The session owns the REPORTING contract; the SDK owns the protocol:
 *
 * - `EventsCoordinator.step` performs every poll/webhook lifecycle transition
 *   (subscribe, refresh, poll, unsubscribe). The session only commits each
 *   step's patch to its one in-memory record and waits until `nextActionAt`.
 * - `EventsPushRuntime` holds the `events/stream` request for push mode.
 * - Every mode lands in ONE `MemoryEventInbox` journal, and the session prints
 *   that journal — so a polled, pushed and webhook-delivered event look the
 *   same on stdout, exactly as they do to a trigger.
 *
 * Contract:
 *
 * - **stdout is NDJSON journal entries only**, one per line, in both output
 *   formats: `{seq, kind, origin, eventId, name, timestamp, data, cursor}`.
 * - **Human status goes to stderr**, scrubbed of anything secret-shaped.
 * - **Stopping removes.** On a signal, `--duration` or `--max-events` the
 *   record is marked `desiredState: "removed"` and stepped through the
 *   coordinator's removal path, which unsubscribes a webhook subscription.
 *   This process is the only refresher and it has stopped, so the removal's
 *   late-refresh window is zero (the caller builds the coordinator that way).
 */

import {
  applySubscriptionPatch,
  IDLE_NEXT_ACTION_AT,
  type JournalEntry,
  type PushStreamCallbacks,
  type StepOutcome,
  type SubscriptionFailure,
  type SubscriptionRecord,
} from "@mcpjam/sdk/events";

export type EventsWatchStopReason =
  | "signal"
  | "duration"
  | "max-events"
  | "failed"
  | "terminated";

/** One stdout line. Absent envelope fields are `null`, never missing. */
export interface EventsWatchLine {
  seq: number;
  kind: JournalEntry["kind"];
  origin: JournalEntry["origin"];
  eventId: string | null;
  name: string | null;
  timestamp: string | null;
  data: Record<string, unknown> | null;
  cursor: string | null;
  error?: unknown;
  quarantined?: true;
  idConflict?: true;
}

export function toWatchLine(entry: JournalEntry): EventsWatchLine {
  return {
    seq: entry.seq,
    kind: entry.kind,
    origin: entry.origin,
    eventId: entry.eventId ?? null,
    name: entry.name ?? null,
    timestamp: entry.timestamp ?? null,
    data: entry.data ?? null,
    cursor: entry.cursor ?? null,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.quarantined ? { quarantined: true as const } : {}),
    ...(entry.idConflict ? { idConflict: true as const } : {}),
  };
}

export interface EventsWatchResult {
  stopReason: EventsWatchStopReason;
  /** Delivered (non-quarantined) events printed. */
  events: number;
  /** Journal entries printed, events and control entries alike. */
  entries: number;
  failure?: SubscriptionFailure;
  /** Whether the removal step settled. `false` ⇒ a server subscription may remain until its TTL. */
  removed: boolean;
  record: SubscriptionRecord;
  exitCode: number;
}

export interface EventsWatchDeps {
  coordinator: { step(record: SubscriptionRecord): Promise<StepOutcome> };
  inbox: {
    subscribe(
      after: number,
      listener: (entry: JournalEntry) => void,
    ): { backlog: JournalEntry[]; unsubscribe: () => void };
    ackDispatch(seq: number): void;
  };
  /** Required for `mode: "push"`. */
  push?: {
    start(
      record: SubscriptionRecord,
      callbacks: PushStreamCallbacks,
    ): { stop(): void };
  };
  /** Structured NDJSON sink (stdout). */
  emit(line: EventsWatchLine): void;
  /** Human status sink (stderr). */
  status(message: string): void;
  now?: () => number;
}

export interface EventsWatchOptions {
  durationMs?: number;
  maxEvents?: number;
  /** Removal attempts before giving up on a clean unsubscribe. Default 4. */
  maxTeardownSteps?: number;
}

/** Longest single wait; the loop re-checks `nextActionAt` after it. */
const MAX_SLEEP_MS = 60_000;
/** Cap on the backoff a removal retry waits — a Ctrl-C should not hang. */
const MAX_TEARDOWN_WAIT_MS = 2_000;

function describeRefresh(refreshBefore: number | null | undefined): string {
  if (refreshBefore === null) return "no expiry";
  if (refreshBefore === undefined) return "unknown expiry";
  return `refresh before ${new Date(refreshBefore).toISOString()}`;
}

function isTerminal(record: SubscriptionRecord): boolean {
  return (
    record.observedState === "paused_auth" ||
    record.observedState === "terminated" ||
    (record.observedState === "error" && record.lastError?.retryable === false)
  );
}

export class EventsWatchSession {
  private record: SubscriptionRecord;
  private readonly now: () => number;
  private stopReason?: EventsWatchStopReason;
  private failure?: SubscriptionFailure;
  private events = 0;
  private entries = 0;
  private polledOnce = false;
  private wakers = new Set<() => void>();
  private durationTimer?: ReturnType<typeof setTimeout>;

  constructor(
    record: SubscriptionRecord,
    private readonly options: EventsWatchOptions,
    private readonly deps: EventsWatchDeps,
  ) {
    this.record = record;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Local stop (signal, duration, max events). Idempotent; first reason wins. */
  stop(reason: EventsWatchStopReason): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  get stopping(): boolean {
    return this.stopReason !== undefined;
  }

  async run(): Promise<EventsWatchResult> {
    const feed = this.deps.inbox.subscribe(0, (entry) => this.onEntry(entry));
    for (const entry of feed.backlog) this.onEntry(entry);
    if (this.options.durationMs !== undefined) {
      this.durationTimer = setTimeout(
        () => this.stop("duration"),
        this.options.durationMs,
      );
    }
    try {
      if (this.record.mode === "push") {
        await this.runPush();
      } else {
        await this.runSteps();
      }
    } catch (error) {
      this.fail({
        kind: "internal",
        message: error instanceof Error ? error.message : String(error),
        at: this.now(),
        retryable: false,
      });
    } finally {
      clearTimeout(this.durationTimer);
    }

    const removed = await this.teardown();
    feed.unsubscribe();

    const stopReason = this.stopReason ?? "failed";
    const clean =
      stopReason === "signal" ||
      stopReason === "duration" ||
      stopReason === "max-events";
    return {
      stopReason,
      events: this.events,
      entries: this.entries,
      ...(this.failure ? { failure: this.failure } : {}),
      removed,
      record: this.record,
      exitCode: clean && removed ? 0 : 1,
    };
  }

  // ---------------------------------------------------------------------------

  private onEntry(entry: JournalEntry): void {
    // The CLI is the only consumer: acknowledge so the in-memory inbox's
    // undispatched budget never fills and back-pressures a long watch.
    this.deps.inbox.ackDispatch(entry.seq);
    if (this.stopping) return;
    this.entries += 1;
    this.deps.emit(toWatchLine(entry));
    if (entry.kind === "gap") {
      this.deps.status(
        "Gap: the server could not replay every event since the cursor (truncated); some events were missed.",
      );
    }
    if (entry.kind === "terminated") {
      const message =
        (entry.error as { message?: unknown } | undefined)?.message ?? "terminated";
      this.fail({
        kind: "terminated",
        message: `The server terminated the subscription: ${String(message)}`,
        at: this.now(),
        retryable: false,
      });
      return;
    }
    if (entry.kind === "event" && !entry.quarantined) {
      this.events += 1;
      if (
        this.options.maxEvents !== undefined &&
        this.events >= this.options.maxEvents
      ) {
        this.stop("max-events");
      }
    } else if (entry.quarantined) {
      this.deps.status(
        "Quarantined a delivery whose body was not a valid event (kept in the journal, not dispatched).",
      );
    }
  }

  private fail(failure: SubscriptionFailure): void {
    if (this.stopping) return;
    this.failure = failure;
    this.stop(failure.kind === "terminated" ? "terminated" : "failed");
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(ms, MAX_SLEEP_MS));
      this.wakers.add(done);
    });
  }

  private async untilStopped(): Promise<void> {
    while (!this.stopping) await this.sleep(MAX_SLEEP_MS);
  }

  private async runSteps(): Promise<void> {
    while (!this.stopping) {
      const delay = this.record.nextActionAt - this.now();
      if (delay > 0) {
        await this.sleep(delay);
        continue;
      }
      const outcome = await this.deps.coordinator.step(this.record);
      this.record = applySubscriptionPatch(this.record, outcome);
      this.report(outcome);
      if (isTerminal(this.record)) {
        this.fail(
          this.record.lastError ?? {
            kind: this.record.observedState,
            message: `Subscription is ${this.record.observedState}.`,
            at: this.now(),
            retryable: false,
          },
        );
        return;
      }
      if (outcome.nextActionAt >= IDLE_NEXT_ACTION_AT && !this.stopping) {
        this.fail({
          kind: "idle",
          message: "The coordinator has nothing left to do for this subscription.",
          at: this.now(),
          retryable: false,
        });
        return;
      }
    }
  }

  private report(outcome: StepOutcome): void {
    const record = this.record;
    switch (outcome.action) {
      case "subscribed":
        this.deps.status(
          `Subscribed to ${record.eventName} by webhook (server subscription ${record.serverSubscriptionId ?? "unknown"}; ${describeRefresh(record.refreshBefore)}).`,
        );
        break;
      case "refreshed":
      case "rotated":
        this.deps.status(
          `${outcome.action === "rotated" ? "Rotated and refreshed" : "Refreshed"} the webhook subscription (${describeRefresh(record.refreshBefore)}).`,
        );
        break;
      case "polled":
        if (!this.polledOnce) {
          this.polledOnce = true;
          const next = Math.max(0, outcome.nextActionAt - this.now());
          this.deps.status(
            `Polling ${record.eventName} from cursor ${JSON.stringify(record.lastCursor ?? null)}; next poll in ${next} ms.`,
          );
        }
        break;
      case "failed":
        if (outcome.failure) {
          const retry = outcome.failure.retryable && outcome.nextActionAt < IDLE_NEXT_ACTION_AT
            ? `; retrying in ${Math.max(0, outcome.nextActionAt - this.now())} ms`
            : "";
          this.deps.status(
            `Step failed (${outcome.failure.kind}): ${outcome.failure.message}${retry}.`,
          );
        }
        break;
      default:
        break;
    }
    if (
      record.conflictingServerSubscriptionId &&
      outcome.patch.conflictingServerSubscriptionId
    ) {
      this.deps.status(
        `Subscription id conflict: the server returned ${record.conflictingServerSubscriptionId} for a receiver slot bound to ${record.serverSubscriptionId ?? "another id"}.`,
      );
    }
  }

  private async runPush(): Promise<void> {
    const push = this.deps.push;
    if (!push) throw new Error("push mode requires a push runtime");
    const handle = push.start(this.record, {
      onOpen: ({ attempt, cursor, reason }) => {
        this.deps.status(
          attempt === 1
            ? `Opening events/stream for ${this.record.eventName} from cursor ${JSON.stringify(cursor)}.`
            : `Reopening events/stream (${reason}) from cursor ${JSON.stringify(cursor)}.`,
        );
      },
      onCursor: (cursor) => {
        this.record = { ...this.record, lastCursor: cursor };
      },
      onState: (state) => {
        const wasActive = this.record.observedState === "active";
        this.record = { ...this.record, observedState: state.observedState };
        if (state.observedState === "active" && !wasActive && !state.failure) {
          this.deps.status("Push stream active.");
        }
        if (state.failure) {
          if (
            state.observedState === "terminated" ||
            state.observedState === "error" ||
            state.observedState === "paused_auth"
          ) {
            this.record = { ...this.record, lastError: state.failure };
            this.fail(state.failure);
          } else {
            this.deps.status(
              `Stream problem (${state.failure.kind}): ${state.failure.message}; the runtime will reconnect.`,
            );
          }
        }
      },
    });
    try {
      await this.untilStopped();
    } finally {
      handle.stop();
    }
  }

  /**
   * The coordinator's removal path. For webhook this is `events/unsubscribe`
   * (twice, the second read as "already gone"); for poll and push it settles
   * locally, since neither holds a server-side subscription.
   */
  private async teardown(): Promise<boolean> {
    let record: SubscriptionRecord = { ...this.record, desiredState: "removed" };
    const maxSteps = this.options.maxTeardownSteps ?? 4;
    const remote = record.mode === "webhook" && Boolean(record.callbackUrl);
    if (remote) this.deps.status("Unsubscribing...");
    for (let attempt = 0; attempt < maxSteps; attempt += 1) {
      let outcome: StepOutcome;
      try {
        outcome = await this.deps.coordinator.step(record);
      } catch (error) {
        this.deps.status(
          `Removal step failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
      record = applySubscriptionPatch(record, outcome);
      if (record.observedState === "removed" && record.settledRemovalAt !== undefined) {
        this.record = record;
        if (remote) {
          this.deps.status(
            record.lastError?.kind === "authorization_lost"
              ? "Could not unsubscribe (authorization lost); the server's TTL will reap the subscription."
              : "Unsubscribed.",
          );
        }
        return record.lastError?.kind !== "authorization_lost";
      }
      if (outcome.failure) {
        this.deps.status(
          `Unsubscribe failed (${outcome.failure.kind}): ${outcome.failure.message}`,
        );
        if (!outcome.failure.retryable) break;
      }
      const wait = Math.min(
        Math.max(0, outcome.nextActionAt - this.now()),
        MAX_TEARDOWN_WAIT_MS,
      );
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.record = record;
    this.deps.status(
      "Could not confirm the unsubscribe; the server subscription may remain until its TTL expires.",
    );
    return false;
  }
}
