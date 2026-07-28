/**
 * The shared task lifecycle engine.
 *
 * Before this module, every Tasks surface (the Tasks tab, chat, the hosted
 * routes, the public API, the CLI) grew its own polling loop and its own idea
 * of when a task is finished. That is how the poll floor got violated: the
 * Tasks tab collapsed every active task to a single `Math.min(...)` across
 * their advertised intervals and then let a user override *replace* the
 * server's floor rather than be clamped by it.
 *
 * The engine owns exactly one thing per task: **when it is next allowed to be
 * polled, and what we last saw**. It performs no I/O. Callers ask it what is
 * due, do the transport work themselves, and hand the outcome back through
 * {@link TaskLifecycleEngine.observe} / {@link TaskLifecycleEngine.observeError}.
 * That keeps it usable from a browser tab, a Hono route, a Convex action, and
 * the CLI without any of them sharing a transport.
 *
 * ## The poll-interval rule
 *
 * ```text
 * effective interval = max(
 *   server pollIntervalMs,   // the floor the server asked for
 *   user minimum,            // a *preference*, never a licence to go faster
 *   retry backoff,           // exponential, after consecutive errors
 *   Retry-After              // a 429/503 hint, absolute
 * )
 * ```
 *
 * `pollIntervalMs` MAY change over a task's lifetime (`tasks.md:308`), in
 * either direction. A shrinking value is normal and must never be reported as
 * an anomaly. Both wires feed the same formula; only the validators differ.
 */

import type { InputRequests } from "./tasks-ext-types.js";
import type { TasksWire } from "./tasks-dispatch.js";

/** The two wires that can actually carry a task. `"none"` never reaches here. */
export type LiveTasksWire = Exclude<TasksWire, "none">;

/**
 * Stable identity for a task handle.
 *
 * `wire` is part of the identity, not a decoration: the same task ID can exist
 * on both wires while a developer flips protocol versions, and a stored handle
 * must never silently change behavior because a server was reconfigured.
 * `scope` is the auth/org context (hosted `projectId`), which keeps bearer-ish
 * task IDs from leaking between accounts sharing a browser.
 */
export interface TaskLifecycleIdentity {
  scope?: string;
  serverId: string;
  wire: LiveTasksWire;
  taskId: string;
}

/** Composite key for {@link TaskLifecycleIdentity}. NUL-joined: no field may contain it. */
export function taskLifecycleKey(identity: TaskLifecycleIdentity): string {
  return [
    identity.scope ?? "",
    identity.serverId,
    identity.wire,
    identity.taskId,
  ].join("\u0000");
}

/**
 * Normalized status across both wires.
 *
 * `expired` is MCPJam's own tombstone for a handle the server no longer knows
 * (a confirmed `-32602` on `tasks/get`), not a protocol status. `unknown` is
 * the pre-first-observation state of a freshly registered handle.
 */
export type TaskLifecycleStatus =
  | "unknown"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

/** Statuses that will never change again. `expired` is terminal for MCPJam. */
export const TERMINAL_LIFECYCLE_STATUSES: readonly TaskLifecycleStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "expired",
];

export function isTerminalLifecycleStatus(
  status: TaskLifecycleStatus
): boolean {
  return TERMINAL_LIFECYCLE_STATUSES.includes(status);
}

/** JSON-RPC error carried by a `failed` task. */
export interface TaskLifecycleError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A wire-neutral observation of a task.
 *
 * Both wires normalize into this before reaching the engine, so the scheduler
 * has no per-wire branches. `raw` preserves what the server actually sent, for
 * the debugger; the engine never interprets it.
 */
export interface TaskLifecycleObservation {
  status: Exclude<TaskLifecycleStatus, "unknown" | "expired">;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  /** `null` means "no expiry" and is distinct from an absent field. */
  ttlMs?: number | null;
  pollIntervalMs?: number;
  inputRequests?: InputRequests;
  result?: Record<string, unknown>;
  error?: TaskLifecycleError;
  raw?: unknown;
}

/** Where an observation came from. Notifications do not reset error backoff blame. */
export type TaskObservationSource = "poll" | "notification" | "create";

/** Everything the engine knows about one handle. */
export interface TaskLifecycleRecord {
  readonly key: string;
  readonly identity: TaskLifecycleIdentity;
  status: TaskLifecycleStatus;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  ttlMs: number | null;
  /** Latest server-advertised floor. MAY move in either direction. */
  pollIntervalMs?: number;
  inputRequests?: InputRequests;
  result?: Record<string, unknown>;
  error?: TaskLifecycleError;
  raw?: unknown;
  /** Epoch ms this task may next be polled. */
  nextPollAt: number;
  /** Consecutive transport/protocol errors; drives exponential backoff. */
  consecutiveErrors: number;
  /** Absolute epoch ms from a `Retry-After`, if one is in force. */
  retryAfterUntil?: number;
  /** Last time ANY live read answered for this handle, including a `-32602`. */
  lastObservedAt?: number;
  /** A `tasks/cancel` has been sent; the task may still complete normally. */
  cancellationRequested: boolean;
  /** Input keys whose `tasks/update` acknowledgement succeeded. */
  respondedInputKeys: Set<string>;
  /** Provenance, for the surfaces that show it. */
  toolName?: string;
  surface?: string;
}

/** Snapshot form of a record — safe to serialize and hand to a UI. */
export interface TaskLifecycleSnapshot
  extends Omit<TaskLifecycleRecord, "respondedInputKeys"> {
  respondedInputKeys: string[];
  terminal: boolean;
}

export interface TaskLifecycleCallbacks {
  onTaskCreated?: (record: TaskLifecycleSnapshot) => void;
  onState?: (
    record: TaskLifecycleSnapshot,
    previous: TaskLifecycleStatus
  ) => void;
  onInputRequired?: (record: TaskLifecycleSnapshot) => void;
  onTerminal?: (record: TaskLifecycleSnapshot) => void;
}

export interface TaskLifecycleEngineOptions {
  /**
   * The user's *preferred minimum* interval. A preference, never permission to
   * poll faster than the server's floor — it enters the formula as one more
   * `max` term.
   */
  userMinimumIntervalMs?: number;
  /** Hard floor applied to every task, whatever anyone asked for. */
  absoluteFloorMs?: number;
  /** Cap on any single computed interval, so a hostile `pollIntervalMs` cannot park a task forever. */
  maximumIntervalMs?: number;
  /** First backoff step after one error; doubles per consecutive error. */
  errorBackoffBaseMs?: number;
  errorBackoffMaxMs?: number;
  now?: () => number;
  callbacks?: TaskLifecycleCallbacks;
}

const DEFAULT_ABSOLUTE_FLOOR_MS = 250;
const DEFAULT_MAXIMUM_INTERVAL_MS = 5 * 60_000;
const DEFAULT_ERROR_BACKOFF_BASE_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_MAX_MS = 60_000;

/**
 * Coerces a caller-supplied interval to a usable non-negative number.
 *
 * `Math.max(0, NaN)` is `NaN`, and a `NaN` interval propagates into
 * `nextPollAt`, where every comparison is false — so a single malformed
 * preference would silently stop ALL polling rather than failing loudly.
 */
function normalizeInterval(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Guards against `NaN`/`Infinity`/negative values arriving from a server. */
function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function toSnapshot(record: TaskLifecycleRecord): TaskLifecycleSnapshot {
  return {
    ...record,
    respondedInputKeys: [...record.respondedInputKeys],
    terminal: isTerminalLifecycleStatus(record.status),
  };
}

/**
 * Per-task due-time scheduler and state store for MCP Tasks.
 *
 * Deliberately I/O-free: it decides *when* and remembers *what*, and the
 * caller owns the transport. See the module comment for why.
 */
export class TaskLifecycleEngine {
  private readonly records = new Map<string, TaskLifecycleRecord>();
  private readonly now: () => number;
  private readonly absoluteFloorMs: number;
  private readonly maximumIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private userMinimumIntervalMs: number;
  private callbacks: TaskLifecycleCallbacks;

  constructor(options: TaskLifecycleEngineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.absoluteFloorMs = options.absoluteFloorMs ?? DEFAULT_ABSOLUTE_FLOOR_MS;
    this.maximumIntervalMs =
      options.maximumIntervalMs ?? DEFAULT_MAXIMUM_INTERVAL_MS;
    this.backoffBaseMs =
      options.errorBackoffBaseMs ?? DEFAULT_ERROR_BACKOFF_BASE_MS;
    this.backoffMaxMs =
      options.errorBackoffMaxMs ?? DEFAULT_ERROR_BACKOFF_MAX_MS;
    this.userMinimumIntervalMs = normalizeInterval(
      options.userMinimumIntervalMs
    );
    this.callbacks = options.callbacks ?? {};
  }

  setCallbacks(callbacks: TaskLifecycleCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Updates the user's preferred minimum. Existing due times are recomputed so
   * a *slower* preference takes effect immediately rather than after one more
   * fast tick; a *faster* preference can still never breach a server floor.
   */
  setUserMinimumIntervalMs(intervalMs: number): void {
    this.userMinimumIntervalMs = normalizeInterval(intervalMs);
    for (const record of this.records.values()) {
      if (isTerminalLifecycleStatus(record.status)) continue;
      const base = record.lastObservedAt ?? this.now();
      // NEVER earlier, only later. Recomputing from `lastObservedAt` can land
      // in the past while an error backoff or a `Retry-After` is in force —
      // which would let a preference change punch straight through a wait the
      // server asked for. A slower preference still extends the wait, which is
      // the whole point of applying it to already-scheduled tasks.
      record.nextPollAt = Math.max(
        record.nextPollAt,
        base + this.effectiveIntervalMs(record)
      );
    }
  }

  getUserMinimumIntervalMs(): number {
    return this.userMinimumIntervalMs;
  }

  /**
   * The interval this task must not be polled faster than, right now.
   *
   * Every term is a `max`. `Retry-After` participates as a *remaining
   * duration* so it behaves the same as the other relative terms.
   */
  effectiveIntervalMs(record: TaskLifecycleRecord, at?: number): number {
    const now = at ?? this.now();
    const serverFloor = finitePositive(record.pollIntervalMs) ?? 0;
    const backoff =
      record.consecutiveErrors > 0
        ? Math.min(
            this.backoffBaseMs * 2 ** (record.consecutiveErrors - 1),
            this.backoffMaxMs
          )
        : 0;
    const retryAfter = record.retryAfterUntil
      ? Math.max(0, record.retryAfterUntil - now)
      : 0;
    // The cap exists to stop a hostile or nonsensical `pollIntervalMs` from
    // parking a task forever, so it applies to the terms we do not trust.
    // `Retry-After` is NOT one of them: it is an explicit instruction from the
    // server about its own rate limiting, and truncating "back off for ten
    // minutes" to five would mean deliberately ignoring it. So clamp first,
    // then let `Retry-After` raise the result back above the cap.
    const capped = Math.min(
      Math.max(this.absoluteFloorMs, this.userMinimumIntervalMs, backoff),
      Math.max(this.maximumIntervalMs, this.absoluteFloorMs)
    );
    // Both protocol-imposed terms survive the cap. A server that asks to be
    // polled every ten minutes, or that answers `Retry-After: 600`, has said
    // something we are obliged to respect; clamping either to a local five
    // minutes would mean deliberately polling twice as often as we were told
    // to. The cap therefore governs only the terms MCPJam itself invented.
    return Math.max(capped, serverFloor, retryAfter);
  }

  get(identity: TaskLifecycleIdentity): TaskLifecycleRecord | undefined {
    return this.records.get(taskLifecycleKey(identity));
  }

  getByKey(key: string): TaskLifecycleRecord | undefined {
    return this.records.get(key);
  }

  snapshot(identity: TaskLifecycleIdentity): TaskLifecycleSnapshot | undefined {
    const record = this.get(identity);
    return record ? toSnapshot(record) : undefined;
  }

  all(): TaskLifecycleSnapshot[] {
    return [...this.records.values()].map(toSnapshot);
  }

  /**
   * Registers a handle. Idempotent: re-registering an existing task returns the
   * live record rather than resetting its schedule, so a reconnect or a second
   * surface adopting the same handle cannot restart its backoff.
   */
  register(
    identity: TaskLifecycleIdentity,
    init: {
      createdAt?: string;
      ttlMs?: number | null;
      pollIntervalMs?: number;
      status?: TaskLifecycleStatus;
      toolName?: string;
      surface?: string;
      /** Adopted from durable storage; not re-notified as a creation. */
      restored?: boolean;
      respondedInputKeys?: readonly string[];
    } = {}
  ): TaskLifecycleRecord {
    const key = taskLifecycleKey(identity);
    const existing = this.records.get(key);
    if (existing) return existing;

    const now = this.now();
    const record: TaskLifecycleRecord = {
      key,
      identity: { ...identity },
      status: init.status ?? "unknown",
      createdAt: init.createdAt,
      ttlMs: init.ttlMs ?? null,
      pollIntervalMs: finitePositive(init.pollIntervalMs),
      nextPollAt: now,
      consecutiveErrors: 0,
      cancellationRequested: false,
      respondedInputKeys: new Set(init.respondedInputKeys ?? []),
      toolName: init.toolName,
      surface: init.surface,
    };
    // A fresh handle is due immediately; the floor applies from the first
    // observation onward, so the first read is never artificially delayed.
    this.records.set(key, record);
    if (!init.restored) {
      this.callbacks.onTaskCreated?.(toSnapshot(record));
    }
    return record;
  }

  /** Drops a handle from scheduling. Does not touch durable storage. */
  forget(identity: TaskLifecycleIdentity): void {
    this.records.delete(taskLifecycleKey(identity));
  }

  clear(): void {
    this.records.clear();
  }

  /**
   * Folds a validated observation into the record and reschedules.
   *
   * Notifications and polls are reconciled identically — the extension makes
   * notifications an optimization, never a separate source of truth — except
   * that a notification does not by itself prove the *poll* path is healthy,
   * so it clears the error count only when it actually carried state.
   */
  observe(
    identity: TaskLifecycleIdentity,
    observation: TaskLifecycleObservation,
    source: TaskObservationSource = "poll"
  ): TaskLifecycleRecord {
    const record = this.register(identity, { restored: true });
    const previous = record.status;
    const now = this.now();

    // Terminal is FINAL. A poll issued before a terminal notification arrived
    // can land after it, and applying it would revert a completed task's UI
    // and scheduling to `working` — resurrecting a handle we already retired.
    // The observation is still evidence the handle exists, so the observation
    // clock advances; nothing else does.
    if (isTerminalLifecycleStatus(record.status)) {
      record.lastObservedAt = now;
      return record;
    }

    record.status = observation.status;
    // Assigned unconditionally: an observation is a FULL snapshot, so a server
    // omitting `statusMessage` is clearing it. Keeping the previous value
    // would leave a stale message on screen after the condition it described
    // was resolved.
    record.statusMessage = observation.statusMessage;
    if (observation.createdAt !== undefined) {
      record.createdAt = observation.createdAt;
    }
    if (observation.lastUpdatedAt !== undefined) {
      record.lastUpdatedAt = observation.lastUpdatedAt;
    }
    if (observation.ttlMs !== undefined) {
      // `null` is meaningful (no expiry) and must overwrite a previous number.
      record.ttlMs = observation.ttlMs;
    }
    if (observation.pollIntervalMs !== undefined) {
      // MAY move in either direction (`tasks.md:308`). A shrinking floor is
      // normal; never flag it.
      record.pollIntervalMs = finitePositive(observation.pollIntervalMs);
    }
    record.inputRequests = observation.inputRequests;
    record.result = observation.result;
    record.error = observation.error;
    record.raw = observation.raw;
    record.lastObservedAt = now;
    if (source !== "notification") {
      // Only a successful READ proves the poll path recovered. A notification
      // arrives on a different channel entirely, so clearing the backoff on one
      // would drop us straight back to the normal floor against a server whose
      // `tasks/get` is still failing.
      record.consecutiveErrors = 0;
      record.retryAfterUntil = undefined;
    }

    const terminal = isTerminalLifecycleStatus(record.status);
    record.nextPollAt = terminal
      ? Number.POSITIVE_INFINITY
      : now + this.effectiveIntervalMs(record, now);

    const snapshot = toSnapshot(record);
    if (previous !== record.status) {
      this.callbacks.onState?.(snapshot, previous);
      if (record.status === "input_required") {
        this.callbacks.onInputRequired?.(snapshot);
      }
      if (terminal) {
        this.callbacks.onTerminal?.(snapshot);
      }
    } else if (record.status === "input_required" && source !== "create") {
      // The keyed snapshot is re-sent on every poll and MAY grow. Re-announce
      // so a newly-added key is surfaced even though the status did not change.
      this.callbacks.onInputRequired?.(snapshot);
    }
    return record;
  }

  /**
   * Records a failed read. Increments backoff and reschedules; never changes
   * the task's status, because a transport failure says nothing about the task.
   */
  observeError(
    identity: TaskLifecycleIdentity,
    options: { retryAfterMs?: number } = {}
  ): TaskLifecycleRecord {
    const record = this.register(identity, { restored: true });
    const now = this.now();
    record.consecutiveErrors += 1;
    const retryAfter = finitePositive(options.retryAfterMs);
    if (retryAfter !== undefined) {
      record.retryAfterUntil = now + retryAfter;
    }
    record.nextPollAt = now + this.effectiveIntervalMs(record, now);
    return record;
  }

  /**
   * Applies a `Retry-After` without counting an error — for a 429 that is rate
   * limiting rather than failure.
   */
  applyRetryAfter(identity: TaskLifecycleIdentity, retryAfterMs: number): void {
    const record = this.register(identity, { restored: true });
    const now = this.now();
    const ms = finitePositive(retryAfterMs);
    if (ms === undefined) return;
    record.retryAfterUntil = now + ms;
    record.nextPollAt = Math.max(record.nextPollAt, now + ms);
  }

  /**
   * Marks the handle unknown to the server. Only ever called from a **confirmed
   * `tasks/get` `-32602`** — that is the one method carrying the MUST
   * (`tasks.md:793-795`); update/cancel carry a SHOULD, so a `-32602` from
   * either is a hint that must be confirmed with a `tasks/get` first.
   */
  markExpired(identity: TaskLifecycleIdentity): TaskLifecycleRecord {
    const record = this.register(identity, { restored: true });
    const previous = record.status;
    record.status = "expired";
    record.lastObservedAt = this.now();
    record.nextPollAt = Number.POSITIVE_INFINITY;
    record.consecutiveErrors = 0;
    const snapshot = toSnapshot(record);
    if (previous !== "expired") {
      this.callbacks.onState?.(snapshot, previous);
      this.callbacks.onTerminal?.(snapshot);
    }
    return record;
  }

  /**
   * Notes that a `tasks/cancel` was accepted. Cancellation is cooperative: the
   * ack says nothing about the task's fate, so the status is left alone and
   * polling continues until a real terminal state is observed.
   */
  markCancellationRequested(identity: TaskLifecycleIdentity): void {
    const record = this.register(identity, { restored: true });
    record.cancellationRequested = true;
  }

  /**
   * Marks an input key answered. Called only *after* the `tasks/update`
   * acknowledgement succeeds — an optimistic mark would silently drop the
   * user's answer if the update failed.
   */
  markInputKeysResponded(
    identity: TaskLifecycleIdentity,
    keys: readonly string[]
  ): void {
    const record = this.register(identity, { restored: true });
    for (const key of keys) record.respondedInputKeys.add(key);
  }

  /**
   * Input keys in the current snapshot that have not been answered yet.
   * Own-property checked: a hostile key such as `constructor` must not be
   * inherited from the prototype chain.
   */
  pendingInputKeys(identity: TaskLifecycleIdentity): string[] {
    const record = this.get(identity);
    if (!record?.inputRequests) return [];
    return Object.keys(record.inputRequests).filter(
      (key) =>
        Object.prototype.hasOwnProperty.call(record.inputRequests, key) &&
        !record.respondedInputKeys.has(key)
    );
  }

  /**
   * Handles due for a poll now, soonest first. Terminal handles are never due.
   */
  due(at?: number): TaskLifecycleRecord[] {
    const now = at ?? this.now();
    return [...this.records.values()]
      .filter(
        (record) =>
          !isTerminalLifecycleStatus(record.status) && record.nextPollAt <= now
      )
      .sort((a, b) => a.nextPollAt - b.nextPollAt);
  }

  /** Non-terminal handles, whether or not they are due. */
  active(): TaskLifecycleRecord[] {
    return [...this.records.values()].filter(
      (record) => !isTerminalLifecycleStatus(record.status)
    );
  }

  /**
   * Milliseconds until the next handle becomes due, for a caller that wants to
   * arm one timer instead of ticking. `undefined` when nothing is pending.
   */
  msUntilNextDue(at?: number): number | undefined {
    const now = at ?? this.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const record of this.records.values()) {
      if (isTerminalLifecycleStatus(record.status)) continue;
      soonest = Math.min(soonest, record.nextPollAt);
    }
    if (!Number.isFinite(soonest)) return undefined;
    return Math.max(0, soonest - now);
  }

  /**
   * Reserves the given handles: pushes each one's due time forward by its own
   * effective interval. Call this when a batch is dispatched so an in-flight
   * request is not re-issued by the next tick.
   */
  reserve(records: readonly TaskLifecycleRecord[], at?: number): void {
    const now = at ?? this.now();
    for (const record of records) {
      record.nextPollAt = now + this.effectiveIntervalMs(record, now);
    }
  }

  /**
   * The interval a *batch* must respect: the **maximum** floor among its
   * members, not the minimum. A batch polls every member, so honoring the
   * fastest member's floor would breach every slower member's.
   */
  batchIntervalMs(
    records: readonly TaskLifecycleRecord[],
    at?: number
  ): number {
    const now = at ?? this.now();
    let interval = Math.max(this.absoluteFloorMs, this.userMinimumIntervalMs);
    for (const record of records) {
      interval = Math.max(interval, this.effectiveIntervalMs(record, now));
    }
    return interval;
  }
}
