import type { EventsFeedEntryView } from "@/shared/events-api";
import type { EventOutcome } from "./event-dispatch";

/** One occurrence an Events card lists. */
export interface RecentEvent {
  key: string;
  receivedAt: number;
  origin: EventsFeedEntryView["origin"];
  /** Unset while the turn is being sent. */
  outcome?: EventOutcome;
}

/** Enough to see an event that keeps firing, few enough to stay short. */
export const RECENT_EVENT_LIMIT = 10;

const keyOf = (entry: EventsFeedEntryView) =>
  JSON.stringify([entry.namespace, entry.eventId ?? entry.seq]);

/** The list with a new arrival first, oldest dropped past the limit. */
export function withArrival(
  events: readonly RecentEvent[] | undefined,
  entry: EventsFeedEntryView,
): RecentEvent[] {
  return [
    { key: keyOf(entry), receivedAt: entry.receivedAt, origin: entry.origin },
    ...(events ?? []),
  ].slice(0, RECENT_EVENT_LIMIT);
}

/**
 * Matched by occurrence, not position: a send can finish after a later
 * occurrence arrived and was skipped.
 */
export function withOutcome(
  events: readonly RecentEvent[] | undefined,
  entry: EventsFeedEntryView,
  outcome: EventOutcome,
): RecentEvent[] | undefined {
  const key = keyOf(entry);
  return events?.map((event) =>
    event.key === key ? { ...event, outcome } : event,
  );
}

/** Clock time, with seconds where events can arrive close together. */
export function eventTime(
  receivedAt: number,
  { seconds = true, locale }: { seconds?: boolean; locale?: string } = {},
): string {
  return new Date(receivedAt).toLocaleTimeString(
    locale,
    seconds ? undefined : { hour: "numeric", minute: "2-digit" },
  );
}

export function outcomeLabel(event: RecentEvent): string {
  const outcome = !event.outcome
    ? "Sending to agent"
    : event.outcome.status === "sent"
      ? "Sent to agent"
      : event.outcome.status === "skipped"
        ? "Skipped"
        : "Not sent";
  return event.origin === "simulation" ? `Test · ${outcome}` : outcome;
}
