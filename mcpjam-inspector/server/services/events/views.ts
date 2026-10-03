/**
 * Projections from the SDK's events records onto the inspector's route
 * contracts (`shared/events-api.ts`). Field by field on purpose: a field added
 * to a record (a slot secret, say) can never reach a response by accident.
 */

import {
  IDLE_NEXT_ACTION_AT,
  type JournalEntry,
  type Rejection,
  type SubscriptionRecord,
} from "@mcpjam/sdk/events";
import type {
  EventsFeedEntryView,
  EventsRejectionView,
  EventsSubscriptionView,
} from "@/shared/events-api";

export type LocalOverride = "insecure-local-receiver";

export function subscriptionView(
  record: SubscriptionRecord,
  extras: { locality: "local" | "hosted"; overrides?: LocalOverride[] },
): EventsSubscriptionView {
  return {
    id: record.id,
    serverId: record.serverId,
    eventName: record.eventName,
    arguments: record.arguments,
    mode: record.mode,
    profile: record.profile,
    desiredState: record.desiredState,
    observedState: record.observedState,
    generation: record.generation,
    ...(record.nextActionAt < IDLE_NEXT_ACTION_AT
      ? { nextActionAt: record.nextActionAt }
      : {}),
    ...(record.refreshBefore !== undefined ? { refreshBefore: record.refreshBefore } : {}),
    ...(record.lastCursor !== undefined ? { lastCursor: record.lastCursor } : {}),
    ...(record.callbackUrl ? { callbackUrl: record.callbackUrl } : {}),
    ...(record.serverSubscriptionId
      ? { serverSubscriptionId: record.serverSubscriptionId }
      : {}),
    ...(record.conflictingServerSubscriptionId
      ? { conflictingServerSubscriptionId: record.conflictingServerSubscriptionId }
      : {}),
    ...(record.deliveryStatus !== undefined ? { deliveryStatus: record.deliveryStatus } : {}),
    ...(record.lastError
      ? {
          lastError: {
            kind: record.lastError.kind,
            message: record.lastError.message,
            at: record.lastError.at,
            retryable: record.lastError.retryable,
          },
        }
      : {}),
    consecutiveFailures: record.consecutiveFailures,
    ...(record.lastGapAt !== undefined ? { lastGapAt: record.lastGapAt } : {}),
    locality: extras.locality,
    ...(extras.overrides && extras.overrides.length > 0
      ? { overrides: [...extras.overrides] }
      : {}),
  };
}

/**
 * A journal entry as the feed carries it. `dispatch` is omitted for the local
 * runtime, which has no trigger dispatcher (triggers run hosted only).
 */
export function feedEntryView(
  entry: JournalEntry,
  options: { includeDispatch?: boolean } = {},
): EventsFeedEntryView {
  return {
    seq: entry.seq,
    kind: entry.quarantined ? "quarantined" : entry.kind,
    origin: entry.origin,
    namespace: entry.namespace,
    logicalSubscriptionId: entry.logicalSubscriptionId,
    ...(entry.slotId ? { slotId: entry.slotId } : {}),
    ...(entry.serverSubscriptionId !== undefined
      ? { serverSubscriptionId: entry.serverSubscriptionId }
      : {}),
    ...(entry.eventId !== undefined ? { eventId: entry.eventId } : {}),
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    ...(entry.data !== undefined ? { data: entry.data } : {}),
    ...(entry.cursor !== undefined ? { cursor: entry.cursor } : {}),
    receivedAt: entry.receivedAt,
    ...(options.includeDispatch ? { dispatch: entry.dispatch } : {}),
    ...(entry.idConflict ? { idConflict: true } : {}),
    ...(entry.webhookIdMismatch ? { webhookIdMismatch: true } : {}),
    ...(entry.quarantined ? { quarantined: true } : {}),
    ...(entry.error
      ? {
          error: {
            code: entry.error.code,
            message: entry.error.message,
            ...(entry.error.data !== undefined ? { data: entry.error.data } : {}),
          },
        }
      : {}),
  };
}

export function rejectionView(rejection: Rejection): EventsRejectionView {
  return {
    reason: rejection.reason,
    ...(rejection.slotId ? { slotId: rejection.slotId } : {}),
    at: rejection.at,
    headerNames: [...rejection.headerNames],
    bodyBytes: rejection.bodyBytes,
  };
}
