import { describe, expect, it } from "vitest";
import type { EventsFeedEntryView } from "@/shared/events-api";
import {
  RECENT_EVENT_LIMIT,
  eventTime,
  outcomeLabel,
  withArrival,
  withOutcome,
} from "../recent-events";

const entry = (eventId: string, receivedAt = 0): EventsFeedEntryView => ({
  seq: receivedAt,
  kind: "event",
  origin: "poll",
  namespace: "live",
  logicalSubscriptionId: "logical",
  eventId,
  name: "demo.ping",
  receivedAt,
});

describe("recent events", () => {
  it("keeps the newest events first, up to the limit", () => {
    let events = withArrival(undefined, entry("e0", 0));
    for (let i = 1; i <= RECENT_EVENT_LIMIT; i++)
      events = withArrival(events, entry(`e${i}`, i));
    expect(events).toHaveLength(RECENT_EVENT_LIMIT);
    expect(events[0].receivedAt).toBe(RECENT_EVENT_LIMIT);
    expect(events.at(-1)?.receivedAt).toBe(1);
  });

  it("gives a late send's result to its own event, not the newest", () => {
    const first = entry("first", 1);
    const second = entry("second", 2);
    let events = withArrival(withArrival(undefined, first), second);
    events = withOutcome(events, second, {
      status: "skipped",
      message: "Agent busy",
    })!;
    events = withOutcome(events, first, {
      status: "sent",
      message: "Event sent to agent",
    })!;
    expect(events.map((event) => event.outcome?.status)).toEqual([
      "skipped",
      "sent",
    ]);
  });

  it("labels each event by what became of it", () => {
    const [pending] = withArrival(undefined, entry("e", 0));
    expect(outcomeLabel(pending)).toBe("Sending to agent");
    expect(
      outcomeLabel({ ...pending, outcome: { status: "sent", message: "" } }),
    ).toBe("Sent to agent");
    expect(
      outcomeLabel({ ...pending, outcome: { status: "skipped", message: "" } }),
    ).toBe("Skipped");
    expect(
      outcomeLabel({ ...pending, outcome: { status: "queued", message: "" } }),
    ).toBe("Queued");
    expect(
      outcomeLabel({
        ...pending,
        origin: "simulation",
        outcome: { status: "failed", message: "" },
      }),
    ).toBe("Test · Not sent");
  });

  it("shows seconds in the list and minutes in the summary", () => {
    const at = new Date(2026, 10, 25, 9, 30, 34).getTime();
    expect(eventTime(at, { locale: "en-US" })).toBe("9:30:34 AM");
    expect(eventTime(at, { seconds: false, locale: "en-US" })).toBe("9:30 AM");
  });
});
