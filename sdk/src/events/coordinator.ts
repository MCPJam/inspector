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
 * Draft rules encoded here and in `coordinator-removal.ts` (section names
 * from draft@28ec35e):
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

import { normalizeCursor } from "../mcp-client-manager/events-ext-schemas.js";
import { DEFAULT_POLL_FLOOR_MS } from "../mcp-client-manager/events-ext.js";
import {
  BASE_BACKOFF_MS,
  COORDINATOR_DEFAULTS,
  IDLE_NEXT_ACTION_AT,
  MAX_SLOT_REPLACEMENTS_PER_STEP,
  classifyStepFailure,
  computeBackoffMs,
  computePollBatchId,
  computeRefreshAt,
  computeSlotAllocationKey,
  parseRefreshBefore,
  type EventsCoordinatorOptions,
  type ResolvedCoordinatorOptions,
  type StepOutcome,
} from "./coordinator-policy.js";
import {
  stepPause,
  stepRemoval,
  type CoordinatorStepContext,
} from "./coordinator-removal.js";
import { getEventsProfile } from "./profiles.js";
import {
  InboxBackpressureError,
  type InboxAppendEntry,
  type InboxSlotAllocation,
  type SubscriptionPatch,
  type SubscriptionRecord,
} from "./types.js";

export {
  IDLE_NEXT_ACTION_AT,
  applySubscriptionPatch,
  classifyStepFailure,
  computeBackoffMs,
  computePollBatchId,
  computeRefreshAt,
  computeSlotAllocationKey,
} from "./coordinator-policy.js";
export type {
  EventsCoordinatorOptions,
  StepAction,
  StepOutcome,
} from "./coordinator-policy.js";

export class EventsCoordinator {
  private readonly options: ResolvedCoordinatorOptions;

  constructor(options: EventsCoordinatorOptions) {
    // An option passed as `undefined` means "the default", not "undefined"
    // (a `maxPagesPerStep: undefined` would otherwise poll zero pages).
    const given = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined)
    );
    this.options = {
      ...COORDINATOR_DEFAULTS,
      clock: { now: () => Date.now() },
      ...given,
    } as ResolvedCoordinatorOptions;
  }

  private now(): number {
    return this.options.clock.now();
  }

  /** The coordinator as the pause and removal steps see it. */
  private context(): CoordinatorStepContext {
    return {
      options: this.options,
      now: () => this.now(),
      idle: () => this.idle(),
      fail: (record, method, error, extraPatch) =>
        this.fail(record, method, error, extraPatch),
    };
  }

  /** Perform the next lifecycle transition for `record`. */
  async step(record: SubscriptionRecord): Promise<StepOutcome> {
    if (record.desiredState === "removed") return stepRemoval(this.context(), record);
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
    if (record.desiredState === "paused") return stepPause(this.context(), record);
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
}
