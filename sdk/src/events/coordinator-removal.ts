/**
 * The pause and removal steps of the MCP Events coordinator (contract C4):
 * the transitions that take a subscription's receivers down upstream.
 * `EventsCoordinator.step` dispatches to them; like every step they return a
 * patch and never persist it.
 */

import {
  IDLE_NEXT_ACTION_AT,
  MAX_UNRECORDED_SLOTS,
  classifyStepFailure,
  computeSlotAllocationKey,
  type ResolvedCoordinatorOptions,
  type StepOutcome,
} from "./coordinator-policy.js";
import type {
  InboxPort,
  InboxSlotAllocation,
  SubscriptionPatch,
  SubscriptionRecord,
} from "./types.js";

/** What the pause and removal steps need from the coordinator running them. */
export interface CoordinatorStepContext {
  options: ResolvedCoordinatorOptions;
  now(): number;
  idle(): StepOutcome;
  fail(
    record: SubscriptionRecord,
    method: string,
    error: unknown,
    extraPatch?: SubscriptionPatch
  ): StepOutcome;
}

export async function stepPause(
  ctx: CoordinatorStepContext,
  record: SubscriptionRecord
): Promise<StepOutcome> {
  if (record.observedState === "paused") return ctx.idle();
  if (record.mode === "webhook" && record.callbackUrl && record.serverSubscriptionId) {
    try {
      const rpc = await ctx.options.rpc(record);
      await rpc.unsubscribe({
        name: record.eventName,
        arguments: record.arguments,
        delivery: { url: record.callbackUrl },
      });
    } catch (error) {
      return ctx.fail(record, "events/unsubscribe", error);
    }
    // The server's id died with the unsubscribe, and the draft does not
    // promise resume gets it back: unbind the slot (secret and URL kept)
    // so resume binds whatever id it returns instead of a conflict. A retry
    // after a failed unbind unsubscribes again, which is "already gone".
    if (record.slotId) {
      try {
        const inbox = await ctx.options.inbox(record);
        await inbox.unbind(record.slotId);
      } catch (error) {
        return ctx.fail(record, "inbox/unbind", error);
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
export async function stepRemoval(
  ctx: CoordinatorStepContext,
  record: SubscriptionRecord
): Promise<StepOutcome> {
  const now = ctx.now();
  if (record.observedState === "removed" && record.settledRemovalAt !== undefined) {
    return ctx.idle();
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
        const inbox = await ctx.options.inbox(record);
        await inbox.remove(record.slotId);
      } catch (error) {
        return ctx.fail(record, "inbox/remove", error);
      }
    }
    return settled;
  }

  let inbox: InboxPort;
  const receivers: Array<{ slotId?: string; callbackUrl: string }> = [];
  try {
    inbox = await ctx.options.inbox(record);
    if (record.callbackUrl) {
      receivers.push({
        ...(record.slotId ? { slotId: record.slotId } : {}),
        callbackUrl: record.callbackUrl,
      });
    }
    for (const allocation of await unrecordedAllocations(record, inbox)) {
      receivers.push(allocation);
    }
  } catch (error) {
    return ctx.fail(record, "inbox/allocation", error);
  }
  if (receivers.length === 0) {
    // No URL was ever handed out, so no server can be delivering to one.
    if (record.slotId) {
      try {
        await inbox.remove(record.slotId);
      } catch (error) {
        return ctx.fail(record, "inbox/remove", error);
      }
    }
    return settled;
  }

  try {
    const rpc = await ctx.options.rpc(record);
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
    return ctx.fail(record, "events/unsubscribe", error);
  }

  if (record.removalUnsubscribedAt === undefined) {
    for (const receiver of receivers) {
      if (!receiver.slotId) continue;
      try {
        await inbox.remove(receiver.slotId);
      } catch (error) {
        return ctx.fail(record, "inbox/remove", error, {
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
      nextActionAt: now + ctx.options.lateRefreshWindowMs,
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
async function unrecordedAllocations(
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
