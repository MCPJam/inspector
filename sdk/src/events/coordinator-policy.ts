/**
 * The step contract of the MCP Events coordinator (contract C9) and the pure
 * rules it applies: options and defaults, step outcomes, receiver-slot and
 * poll-batch keys, refresh and backoff schedules, failure classification and
 * patch application. Nothing here performs I/O; `coordinator.ts` re-exports
 * the public names.
 */

import { isAuthError } from "../mcp-client-manager/errors.js";
import {
  classifyEventsRpcError,
  isInvalidEventsPayloadError,
} from "../mcp-client-manager/events-ext-guards.js";
import { canonicalJson, sha256Hex } from "../contract/canonical.js";
import {
  InboxBackpressureError,
  type EventsRpcPort,
  type InboxPort,
  type SubscriptionFailure,
  type SubscriptionPatch,
  type SubscriptionRecord,
} from "./types.js";

export interface EventsCoordinatorOptions {
  clock?: { now(): number };
  /** Resolve the MCP port for a subscription's connection binding. */
  rpc(record: SubscriptionRecord): Promise<EventsRpcPort>;
  /** The inbox for a subscription's project. */
  inbox(record: SubscriptionRecord): Promise<InboxPort>;
  /** Poll pages drained per step before yielding (fairness). Default 5. */
  maxPagesPerStep?: number;
  /** Default poll interval when the server gives no `nextPollMs`. 30 s. */
  defaultPollMs?: number;
  /** Health-check cadence for `refreshBefore: null` grants. 6 h. */
  healthCheckIntervalMs?: number;
  /**
   * The longest a refresh can be in flight — after an unsubscribe the keeper
   * unsubscribes once more after this window, in case a refresh already on
   * the wire resurrects the subscription (contract C4). 2 min.
   */
  lateRefreshWindowMs?: number;
  /** Retry cap for transient failures. 30 min. */
  maxBackoffMs?: number;
  /** `challenge_failed` attempts before giving up. 5. */
  maxChallengeFailures?: number;
  /** `maxEvents` sent on poll. Server default when omitted. */
  maxEventsPerPoll?: number;
}

export interface StepOutcome {
  patch: SubscriptionPatch;
  nextActionAt: number;
  /** Events appended to the inbox during this step. */
  appended: number;
  /** What happened, for the caller's log line. Never contains secrets. */
  action: StepAction;
  failure?: SubscriptionFailure;
}

export type StepAction =
  | "idle"
  | "subscribed"
  | "refreshed"
  | "rotated"
  | "polled"
  | "unsubscribed"
  | "removal_settled"
  | "paused"
  | "failed";

/** A time far enough in the future to mean "nothing to do". */
export const IDLE_NEXT_ACTION_AT = Number.MAX_SAFE_INTEGER;

export const COORDINATOR_DEFAULTS = {
  maxPagesPerStep: 5,
  defaultPollMs: 30_000,
  healthCheckIntervalMs: 6 * 60 * 60 * 1000,
  lateRefreshWindowMs: 2 * 60 * 1000,
  maxBackoffMs: 30 * 60 * 1000,
  maxChallengeFailures: 5,
};

/** The options a coordinator runs with: every default filled in. */
export type ResolvedCoordinatorOptions = EventsCoordinatorOptions &
  typeof COORDINATOR_DEFAULTS & { clock: { now(): number } };

export const BASE_BACKOFF_MS = 5_000;

/**
 * Replacements of an expired slot one step may chain (a replayed allocation
 * can itself come back expired). Removal walks further: see
 * `unrecordedAllocations` in `coordinator-removal.ts`.
 */
export const MAX_SLOT_REPLACEMENTS_PER_STEP = 3;
export const MAX_UNRECORDED_SLOTS = 16;

/**
 * The idempotency key of one receiver slot incarnation (contract C3): the
 * subscription's first slot (`replaces: null`), or the slot that replaces the
 * expired `replaces`.
 *
 * It is derived only from what the registry held BEFORE the allocation —
 * never from the generation — so when the commit of a step that allocated is
 * lost (a crash, a lost response, a user edit that wins the compare-and-set),
 * the retry asks for the same incarnation and the inbox answers with the same
 * slot, URL and secret. A fresh URL would be a different upstream
 * subscription that nothing records and so nothing ever unsubscribes.
 */
export function computeSlotAllocationKey(args: {
  logicalSubscriptionId: string;
  replaces: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      kind: "slot-allocation",
      logicalSubscriptionId: args.logicalSubscriptionId,
      replaces: args.replaces,
    })
  );
}

/**
 * When to refresh a webhook grant: `max(60 s, 10% of the remaining grant)`
 * before `refreshBefore`, never in the past, and on the health-check cadence
 * for a no-expiry grant.
 */
export function computeRefreshAt(args: {
  now: number;
  refreshBefore: number | null;
  healthCheckIntervalMs: number;
}): number {
  if (args.refreshBefore === null) {
    return args.now + args.healthCheckIntervalMs;
  }
  const remaining = args.refreshBefore - args.now;
  if (remaining <= 0) return args.now;
  const lead = Math.max(60_000, Math.floor(remaining * 0.1));
  return Math.max(args.now + 1_000, args.refreshBefore - lead);
}

/** Exponential backoff shared in spirit with tasks' pure backoff helpers. */
export function computeBackoffMs(failures: number, maxBackoffMs: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 20);
  return Math.min(maxBackoffMs, BASE_BACKOFF_MS * 2 ** exponent);
}

export function parseRefreshBefore(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Classify a failure as terminal, auth-lost or retryable. Every failure is
 * exactly one of these — there is no "retry forever" path for anything that
 * a retry cannot fix.
 */
export function classifyStepFailure(
  method: string,
  error: unknown,
  now: number
): SubscriptionFailure & { authLost: boolean } {
  if (error instanceof InboxBackpressureError) {
    return {
      kind: "inbox_backpressure",
      message: describe(error),
      at: now,
      retryable: true,
      authLost: false,
    };
  }
  if (isAuthError(error).isAuth) {
    return {
      kind: "authorization_lost",
      message: describe(error),
      at: now,
      retryable: false,
      authLost: true,
    };
  }
  const classified = classifyEventsRpcError(method, error);
  if (classified) {
    const reason = (classified.data as { reason?: unknown } | undefined)?.reason;
    const kind =
      classified.kind === "CallbackEndpointError" && typeof reason === "string"
        ? `callback_${reason}`
        : classified.kind;
    return {
      kind,
      message: classified.message || describe(error),
      at: now,
      // challenge_failed is retried a bounded number of times by the caller.
      retryable:
        classified.retryable ||
        (classified.kind === "CallbackEndpointError" &&
          reason === "challenge_failed"),
      authLost: classified.kind === "Forbidden",
    };
  }
  if (isInvalidEventsPayloadError(error)) {
    return {
      kind: "invalid_server_response",
      message: describe(error),
      at: now,
      retryable: true,
      authLost: false,
    };
  }
  // Network failures, timeouts, 5xx: the OUTCOME is unknown. Every events
  // request is safe to repeat with the same key (subscribe is idempotent,
  // poll re-reads from the persisted cursor), so unknown means retry.
  return {
    kind: "transient",
    message: describe(error),
    at: now,
    retryable: true,
    authLost: false,
  };
}

/** Deterministic batch id: the same page re-appended is the same batch. */
export function computePollBatchId(args: {
  logicalSubscriptionId: string;
  generation: number;
  cursorBefore: string | null;
  eventIds: string[];
  gap: boolean;
}): string {
  return sha256Hex(canonicalJson({ v: 1, kind: "poll-batch", ...args }));
}

/** Apply a step patch to a record (for local stores and tests). */
export function applySubscriptionPatch(
  record: SubscriptionRecord,
  outcome: Pick<StepOutcome, "patch" | "nextActionAt">
): SubscriptionRecord {
  const next: SubscriptionRecord = { ...record, nextActionAt: outcome.nextActionAt };
  for (const [key, value] of Object.entries(outcome.patch)) {
    if (value === undefined) {
      Reflect.deleteProperty(next, key);
    } else {
      Reflect.set(next, key, value);
    }
  }
  return next;
}
