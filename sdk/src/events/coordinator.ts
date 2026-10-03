/**
 * The MCP Events coordinator core (contract C9).
 *
 * ONE place owns every lifecycle transition — subscribe, refresh, rotate,
 * poll, unsubscribe, gap, terminate — for every mode, so the Events tab, the
 * CLI, the hosted keeper, evals and swarms never grow their own loops that
 * disagree about what a `refreshBefore: null` or an empty poll batch means.
 *
 * Shape: {@link EventsCoordinator.step} performs ONE lifecycle transition for
 * one subscription and returns a patch plus the time of its next action. It
 * never loops forever, never sleeps and never persists — the caller (a local
 * runtime or the hosted keeper) commits the patch with compare-and-set on the
 * subscription's generation (contract C4), so a stale keeper's work is simply
 * discarded. Credentials never enter this module: they live behind the
 * `rpc` port, bound to the subscription's connection binding.
 *
 * Draft rules encoded here (section names from draft@28ec35e):
 *   - Absent cursor means `null`; a fresh subscription starts from now.
 *     (*Cursor Lifecycle*)
 *   - An empty poll batch still advances the cursor. (*Cursor advancement*)
 *   - `hasMore` is drained immediately — but for at most `maxPagesPerStep`
 *     pages, so one noisy subscription cannot starve the rest.
 *   - `nextPollMs` gets a floor (1000 ms by default). (*Poll-Based Delivery*)
 *   - `refreshBefore: null` is no expiry — but still health-checked
 *     occasionally. (*Subscription TTL*)
 *   - A `gap` / `truncated: true` is recorded, never auto-resubscribed.
 *   - A second unsubscribe answering NotFound is "already gone".
 */

import { isAuthError } from "../mcp-client-manager/errors.js";
import {
  classifyEventsRpcError,
  isInvalidEventsPayloadError,
} from "../mcp-client-manager/events-ext-guards.js";
import { normalizeCursor } from "../mcp-client-manager/events-ext-schemas.js";
import { DEFAULT_POLL_FLOOR_MS } from "../mcp-client-manager/events-ext.js";
import { canonicalJson, sha256Hex } from "../contract/canonical.js";
import { getEventsProfile } from "./profiles.js";
import {
  InboxBackpressureError,
  type EventsRpcPort,
  type InboxAppendEntry,
  type InboxPort,
  type InboxSlotAllocation,
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

const DEFAULTS = {
  maxPagesPerStep: 5,
  defaultPollMs: 30_000,
  healthCheckIntervalMs: 6 * 60 * 60 * 1000,
  lateRefreshWindowMs: 2 * 60 * 1000,
  maxBackoffMs: 30 * 60 * 1000,
  maxChallengeFailures: 5,
};

const BASE_BACKOFF_MS = 5_000;

/**
 * Replacements of an expired slot one step may chain (a replayed allocation
 * can itself come back expired). Removal walks further: see
 * {@link EventsCoordinator.unrecordedAllocations}.
 */
const MAX_SLOT_REPLACEMENTS_PER_STEP = 3;
const MAX_UNRECORDED_SLOTS = 16;

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

function parseRefreshBefore(value: string | null | undefined): number | null {
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

export class EventsCoordinator {
  private readonly options: EventsCoordinatorOptions &
    typeof DEFAULTS & { clock: { now(): number } };

  constructor(options: EventsCoordinatorOptions) {
    // An option passed as `undefined` means "the default", not "undefined"
    // (a `maxPagesPerStep: undefined` would otherwise poll zero pages).
    const given = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined)
    );
    this.options = {
      ...DEFAULTS,
      clock: { now: () => Date.now() },
      ...given,
    } as EventsCoordinator["options"];
  }

  private now(): number {
    return this.options.clock.now();
  }

  /** Perform the next lifecycle transition for `record`. */
  async step(record: SubscriptionRecord): Promise<StepOutcome> {
    if (record.desiredState === "removed") return this.stepRemoval(record);
    // A terminal observed state waits for the USER (reauthorize, resubscribe),
    // never for a timer: these are exactly the states that must not be
    // retried forever.
    if (
      record.observedState === "paused_auth" ||
      record.observedState === "terminated" ||
      (record.observedState === "error" && record.lastError?.retryable === false)
    ) {
      return this.idle();
    }
    if (record.desiredState === "paused") return this.stepPause(record);
    switch (record.mode) {
      case "webhook":
        return this.stepWebhook(record);
      case "poll":
        return this.stepPoll(record);
      case "push":
        // Push is a held stream, owned by the local push runtime (phase 6);
        // the step loop has nothing to schedule for it.
        return this.idle();
    }
  }

  private idle(): StepOutcome {
    return {
      patch: {},
      nextActionAt: IDLE_NEXT_ACTION_AT,
      appended: 0,
      action: "idle",
    };
  }

  private fail(
    record: SubscriptionRecord,
    method: string,
    error: unknown,
    extraPatch: SubscriptionPatch = {}
  ): StepOutcome {
    const now = this.now();
    const failure = classifyStepFailure(method, error, now);
    // `challenge_failed` is capped on its OWN streak: failures of another
    // kind before it (an outage on the first subscribe) must not spend its
    // attempts, so the count — and with it the backoff — restarts when the
    // previous failure was something else.
    const failures =
      failure.kind === "callback_challenge_failed" &&
      record.lastError?.kind !== "callback_challenge_failed"
        ? 1
        : record.consecutiveFailures + 1;
    const { authLost, ...lastError } = failure;
    if (authLost) {
      return {
        patch: {
          ...extraPatch,
          observedState: "paused_auth",
          lastError: { ...lastError, retryable: false },
          consecutiveFailures: failures,
        },
        nextActionAt: IDLE_NEXT_ACTION_AT,
        appended: 0,
        action: "failed",
        failure: lastError,
      };
    }
    const exhaustedChallenge =
      failure.kind === "callback_challenge_failed" &&
      failures >= this.options.maxChallengeFailures;
    if (!failure.retryable || exhaustedChallenge) {
      return {
        patch: {
          ...extraPatch,
          observedState: "error",
          lastError: { ...lastError, retryable: false },
          consecutiveFailures: failures,
        },
        nextActionAt: IDLE_NEXT_ACTION_AT,
        appended: 0,
        action: "failed",
        failure: lastError,
      };
    }
    const backoff =
      failure.kind === "inbox_backpressure" && error instanceof InboxBackpressureError
        ? Math.max(error.retryAfterMs, BASE_BACKOFF_MS)
        : computeBackoffMs(failures, this.options.maxBackoffMs);
    return {
      patch: {
        ...extraPatch,
        lastError,
        consecutiveFailures: failures,
      },
      nextActionAt: now + backoff,
      appended: 0,
      action: "failed",
      failure: lastError,
    };
  }

  // -------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------

  private async stepWebhook(record: SubscriptionRecord): Promise<StepOutcome> {
    const now = this.now();
    const inbox = await this.options.inbox(record);
    const patch: SubscriptionPatch = {};

    // 1. Allocate the receiver slot BEFORE the server has an id for it
    //    (contract C3): the slot path, not X-MCP-Subscription-Id, selects the
    //    secret, so a challenge that arrives inside the subscribe call — or a
    //    first event that beats the subscribe response — can be verified.
    let slotId = record.slotId;
    let callbackUrl = record.callbackUrl;
    let secret: string | undefined;
    if (slotId && callbackUrl && record.rotation?.phase !== "requested") {
      // A slot never reconciled expires after its pending TTL, and its URL
      // then answers 410 — a challenge sent there can only fail. A first
      // subscribe that outlived it (retries through an outage) gets a fresh
      // slot instead of reusing the dead one.
      try {
        const current = await inbox.getSecret(slotId);
        if (current.state === "expired") {
          slotId = undefined;
          callbackUrl = undefined;
        } else {
          secret = current.secret;
        }
      } catch (error) {
        return this.fail(record, "inbox/secret", error);
      }
    }
    if (!slotId || !callbackUrl) {
      try {
        // Keyed by incarnation, so a step whose commit was lost gets back
        // the slot it already allocated (and maybe already subscribed).
        let replaces = record.slotId ?? null;
        let allocation: InboxSlotAllocation;
        for (let attempt = 1; ; attempt += 1) {
          allocation = await inbox.allocateSlot({
            logicalSubscriptionId: record.id,
            projectId: record.projectId,
            environmentId: record.environmentId,
            bindingKey: record.bindingKey,
            dispatch: true,
            idempotencyKey: computeSlotAllocationKey({
              logicalSubscriptionId: record.id,
              replaces,
            }),
          });
          // A replayed slot whose retries outlived its pending TTL is dead
          // like a recorded one: replace it with the next incarnation.
          if (
            allocation.state !== "expired" ||
            attempt >= MAX_SLOT_REPLACEMENTS_PER_STEP
          ) {
            break;
          }
          replaces = allocation.slotId;
        }
        slotId = allocation.slotId;
        callbackUrl = allocation.callbackUrl;
        secret = allocation.secret;
        patch.slotId = slotId;
        patch.callbackUrl = callbackUrl;
        patch.inboxId = allocation.inboxId;
      } catch (error) {
        return this.fail(record, "inbox/allocate", error);
      }
    }

    // 2. Rotation (contract C3): new secret on the slot FIRST, then refresh
    //    the server with it; the previous secret stays valid on the slot for
    //    the overlap until a refresh with the new one is known to succeed.
    //    Only a kept slot with a rotation requested has no secret yet here.
    let rotated = false;
    if (secret === undefined) {
      try {
        secret = (await inbox.rotate(slotId)).secret;
        patch.rotation = { phase: "rotated", at: now };
        rotated = true;
      } catch (error) {
        return this.fail(record, "inbox/rotate", error, patch);
      }
    }

    // 3. Subscribe / refresh — the same idempotent call either way.
    const rpc = await this.options.rpc(record);
    const refreshing = record.observedState === "active";
    let result;
    try {
      result = await rpc.subscribe({
        name: record.eventName,
        arguments: record.arguments,
        delivery: { url: callbackUrl, secret },
        cursor: record.lastCursor ?? null,
        ...(record.maxAgeMs !== undefined ? { maxAgeMs: record.maxAgeMs } : {}),
        ...(record.ttlMs !== undefined
          ? { ttlMs: record.ttlMs }
          : { ttlMs: this.defaultTtlMs(record) }),
      });
    } catch (error) {
      // Outcome unknown during a rotation: keep `rotated` (the slot already
      // holds the new secret as current) and retry with it — the previous
      // secret is NOT retired until a refresh is known to have landed.
      return this.fail(record, "events/subscribe", error, patch);
    }

    // 4. Reconcile the server's id onto the slot. A different id already on
    //    the slot is a CONFLICT: recorded and surfaced, never merged.
    try {
      const reconciled = await inbox.reconcile(slotId, result.id);
      if (reconciled.conflict) {
        patch.conflictingServerSubscriptionId = reconciled.conflict.proposed;
        patch.lastError = {
          kind: "subscription_id_conflict",
          message: `Server returned subscription id ${reconciled.conflict.proposed}, but the receiver slot is bound to ${reconciled.conflict.existing}.`,
          at: now,
          retryable: false,
        };
      } else {
        patch.serverSubscriptionId = result.id;
      }
    } catch (error) {
      return this.fail(record, "inbox/reconcile", error, patch);
    }

    if (record.rotation?.phase === "rotated" || rotated) {
      try {
        await inbox.retirePrevious(slotId);
        patch.rotation = undefined;
      } catch (error) {
        // Retiring is cleanup; the subscription itself is healthy. The next
        // step retries it through the `rotated` phase.
        patch.rotation = { phase: "rotated", at: now };
        patch.lastError = classifyStepFailure("inbox/retire", error, now);
      }
    }

    const refreshBefore = parseRefreshBefore(result.refreshBefore);
    patch.observedState = "active";
    patch.refreshBefore = refreshBefore;
    // The response cursor is the server's safe-to-persist watermark; absent
    // means null (no replay), exactly like a delivered payload's.
    patch.lastCursor = normalizeCursor(result.cursor);
    if (result.truncated) patch.lastGapAt = now;
    if (result.deliveryStatus !== undefined) {
      patch.deliveryStatus = result.deliveryStatus;
    }
    patch.consecutiveFailures = 0;
    if (!patch.lastError) patch.lastError = undefined;
    patch.lastHealthCheckAt = now;
    return {
      patch,
      nextActionAt: computeRefreshAt({
        now,
        refreshBefore,
        healthCheckIntervalMs: this.options.healthCheckIntervalMs,
      }),
      appended: 0,
      action: rotated ? "rotated" : refreshing ? "refreshed" : "subscribed",
    };
  }

  private defaultTtlMs(record: SubscriptionRecord): number | null | undefined {
    const requested = getEventsProfile(record.profile).requestedTtlMs.value;
    return typeof requested === "number" || requested === null
      ? requested
      : undefined;
  }

  // -------------------------------------------------------------------------
  // Poll
  // -------------------------------------------------------------------------

  private async stepPoll(record: SubscriptionRecord): Promise<StepOutcome> {
    const rpc = await this.options.rpc(record);
    const inbox = await this.options.inbox(record);
    const floor = Math.max(
      DEFAULT_POLL_FLOOR_MS,
      getEventsProfile(record.profile).pollFloorMs.value
    );
    let cursor: string | null = record.lastCursor ?? null;
    let appended = 0;
    let lastGapAt: number | undefined;
    let nextPollMs: number | undefined;
    let hasMore = false;

    for (let page = 0; page < this.options.maxPagesPerStep; page += 1) {
      let result;
      try {
        result = await rpc.poll({
          name: record.eventName,
          arguments: record.arguments,
          cursor,
          ...(record.maxAgeMs !== undefined ? { maxAgeMs: record.maxAgeMs } : {}),
          ...(this.options.maxEventsPerPoll !== undefined
            ? { maxEvents: this.options.maxEventsPerPoll }
            : {}),
        });
      } catch (error) {
        // Whatever was appended and advanced before this page stays advanced.
        return this.fail(record, "events/poll", error, {
          ...(page > 0 ? { lastCursor: cursor } : {}),
          ...(lastGapAt !== undefined ? { lastGapAt } : {}),
        });
      }

      const entries: InboxAppendEntry[] = [...result.events];
      const nextCursor = normalizeCursor(result.cursor);
      if (result.truncated) {
        // Recorded as an explicit gap in the journal — never a resubscribe.
        entries.unshift({ type: "gap", cursor: nextCursor });
        lastGapAt = this.now();
      }
      if (entries.length > 0) {
        try {
          const outcome = await inbox.append({
            logicalSubscriptionId: record.id,
            projectId: record.projectId,
            environmentId: record.environmentId,
            bindingKey: record.bindingKey,
            batchId: computePollBatchId({
              logicalSubscriptionId: record.id,
              generation: record.generation,
              cursorBefore: cursor,
              eventIds: result.events.map((event) => event.eventId),
              gap: result.truncated === true,
            }),
            origin: "poll",
            namespace: "live",
            entries,
          });
          appended += outcome.accepted;
        } catch (error) {
          // The batch is NOT journalled, so the cursor must NOT advance past
          // it: backpressure pauses the loop at the old position.
          return this.fail(record, "inbox/append", error, {
            ...(page > 0 ? { lastCursor: cursor } : {}),
            ...(lastGapAt !== undefined ? { lastGapAt } : {}),
          });
        }
      }
      // Only now — journalled — does the cursor advance. An empty batch
      // advances it too: that is how a quiet subscription keeps its position
      // inside the upstream's retention window.
      cursor = nextCursor;
      nextPollMs = result.nextPollMs;
      hasMore = result.hasMore === true;
      if (!hasMore) break;
    }

    const now = this.now();
    return {
      patch: {
        observedState: "active",
        lastCursor: cursor,
        consecutiveFailures: 0,
        lastError: undefined,
        ...(lastGapAt !== undefined ? { lastGapAt } : {}),
      },
      // Still `hasMore` after the page budget: due again immediately, but
      // behind every other due subscription (fairness).
      nextActionAt: hasMore
        ? now
        : now + Math.max(floor, nextPollMs ?? this.options.defaultPollMs),
      appended,
      action: "polled",
    };
  }

  // -------------------------------------------------------------------------
  // Pause and removal
  // -------------------------------------------------------------------------

  private async stepPause(record: SubscriptionRecord): Promise<StepOutcome> {
    if (record.observedState === "paused") return this.idle();
    if (record.mode === "webhook" && record.callbackUrl && record.serverSubscriptionId) {
      try {
        const rpc = await this.options.rpc(record);
        await rpc.unsubscribe({
          name: record.eventName,
          arguments: record.arguments,
          delivery: { url: record.callbackUrl },
        });
      } catch (error) {
        return this.fail(record, "events/unsubscribe", error);
      }
      // The server's id died with the unsubscribe, and the draft does not
      // promise resume gets it back: unbind the slot (secret and URL kept)
      // so resume binds whatever id it returns instead of a conflict. A retry
      // after a failed unbind unsubscribes again, which is "already gone".
      if (record.slotId) {
        try {
          const inbox = await this.options.inbox(record);
          await inbox.unbind(record.slotId);
        } catch (error) {
          return this.fail(record, "inbox/unbind", error);
        }
      }
    }
    return {
      patch: {
        observedState: "paused",
        consecutiveFailures: 0,
        lastError: undefined,
        // A paused webhook keeps its slot and cursor, so resume re-subscribes
        // at the same URL (same draft key) and replays from the cursor.
        serverSubscriptionId: undefined,
      },
      nextActionAt: IDLE_NEXT_ACTION_AT,
      appended: 0,
      action: "paused",
    };
  }

  /**
   * Removal (contract C4). The registry wrote the tombstone before this runs,
   * so deliveries that race it are journalled but never scheduled. Then:
   * unsubscribe → tombstone the slot → wait out any refresh still in flight →
   * unsubscribe AGAIN → settled. A delivery that lands on the removed slot
   * meanwhile makes the registry reschedule this step immediately.
   *
   * A webhook's receivers are the recorded slot plus any the inbox holds
   * under this subscription's allocation keys that the registry never
   * recorded (a commit lost after allocating, perhaps after subscribing), so
   * removal leaves no live URL upstream however the earlier steps ended.
   */
  private async stepRemoval(record: SubscriptionRecord): Promise<StepOutcome> {
    const now = this.now();
    if (record.observedState === "removed" && record.settledRemovalAt !== undefined) {
      return this.idle();
    }
    const settled: StepOutcome = {
      patch: { observedState: "removed", settledRemovalAt: now },
      nextActionAt: IDLE_NEXT_ACTION_AT,
      appended: 0,
      action: "removal_settled",
    };
    if (record.mode !== "webhook") {
      // Poll and push hold no server-side subscription: stopping is removal.
      if (record.slotId) {
        try {
          const inbox = await this.options.inbox(record);
          await inbox.remove(record.slotId);
        } catch (error) {
          return this.fail(record, "inbox/remove", error);
        }
      }
      return settled;
    }

    let inbox: InboxPort;
    const receivers: Array<{ slotId?: string; callbackUrl: string }> = [];
    try {
      inbox = await this.options.inbox(record);
      if (record.callbackUrl) {
        receivers.push({
          ...(record.slotId ? { slotId: record.slotId } : {}),
          callbackUrl: record.callbackUrl,
        });
      }
      for (const allocation of await this.unrecordedAllocations(record, inbox)) {
        receivers.push(allocation);
      }
    } catch (error) {
      return this.fail(record, "inbox/allocation", error);
    }
    if (receivers.length === 0) {
      // No URL was ever handed out, so no server can be delivering to one.
      if (record.slotId) {
        try {
          await inbox.remove(record.slotId);
        } catch (error) {
          return this.fail(record, "inbox/remove", error);
        }
      }
      return settled;
    }

    try {
      const rpc = await this.options.rpc(record);
      for (const receiver of receivers) {
        await rpc.unsubscribe({
          name: record.eventName,
          arguments: record.arguments,
          delivery: { url: receiver.callbackUrl },
        });
      }
    } catch (error) {
      const failure = classifyStepFailure("events/unsubscribe", error, now);
      if (failure.authLost) {
        // Without credentials there is nothing more we can do remotely; the
        // server's TTL reaps it. Settle locally rather than retry forever.
        return {
          ...settled,
          patch: {
            ...settled.patch,
            lastError: { ...failure, retryable: false },
          },
        };
      }
      return this.fail(record, "events/unsubscribe", error);
    }

    if (record.removalUnsubscribedAt === undefined) {
      for (const receiver of receivers) {
        if (!receiver.slotId) continue;
        try {
          await inbox.remove(receiver.slotId);
        } catch (error) {
          return this.fail(record, "inbox/remove", error, {
            removalUnsubscribedAt: now,
            observedState: "removing",
          });
        }
      }
      return {
        patch: {
          observedState: "removing",
          removalUnsubscribedAt: now,
          consecutiveFailures: 0,
        },
        nextActionAt: now + this.options.lateRefreshWindowMs,
        appended: 0,
        action: "unsubscribed",
      };
    }
    return {
      patch: {
        observedState: "removed",
        settledRemovalAt: now,
        consecutiveFailures: 0,
        lastError: undefined,
      },
      nextActionAt: IDLE_NEXT_ACTION_AT,
      appended: 0,
      action: "removal_settled",
    };
  }

  /**
   * Slots the inbox allocated for this subscription that the registry never
   * recorded: the next incarnation after the recorded slot (or the first
   * slot, when none is recorded), then the one after that, and so on. Only
   * the last can be live — every earlier one was replaced for having
   * expired — but each is cleaned up the same way.
   */
  private async unrecordedAllocations(
    record: SubscriptionRecord,
    inbox: InboxPort
  ): Promise<InboxSlotAllocation[]> {
    const found: InboxSlotAllocation[] = [];
    let replaces = record.slotId ?? null;
    while (found.length < MAX_UNRECORDED_SLOTS) {
      const next = await inbox.findAllocation(
        computeSlotAllocationKey({ logicalSubscriptionId: record.id, replaces })
      );
      if (!next || next.slotId === record.slotId) break;
      found.push(next);
      replaces = next.slotId;
    }
    return found;
  }
}

/** Apply a step patch to a record (for local stores and tests). */
export function applySubscriptionPatch(
  record: SubscriptionRecord,
  outcome: Pick<StepOutcome, "patch" | "nextActionAt">
): SubscriptionRecord {
  const next: SubscriptionRecord = { ...record, nextActionAt: outcome.nextActionAt };
  for (const [key, value] of Object.entries(outcome.patch)) {
    if (value === undefined) {
      delete (next as unknown as Record<string, unknown>)[key];
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}
