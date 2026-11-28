import { describe, expect, it } from "vitest";
import type { EventAtTurn } from "@/shared/event-at-turn";
import {
  eventIdentifierRows,
  eventPromptLabel,
  eventTimingView,
  isTestEvent,
  parseEventTimestamp,
  traceTurnEventsByPromptIndex,
  turnEventsFromTurnTraces,
} from "../trace-turn-event";

const OCCURRED = Date.parse("2026-11-27T10:00:00.000Z");
const RECEIVED = OCCURRED + 120_000;
const TURN_STARTED = RECEIVED + 40_000;

const event: EventAtTurn = {
  name: "comment.created",
  eventId: "evt_1",
  timestamp: "2026-11-27T10:00:00.000Z",
  receivedAt: RECEIVED,
  delivery: "webhook",
  origin: "server",
  subscriptionId: "esub_1",
  triggerId: "trg_1",
};

/** Clock times as epoch ms, so the assertions do not depend on the locale. */
const asMs = (ms: number) => `t=${ms}`;

describe("eventTimingView", () => {
  it("shows occurred, received and turn started with the wait between each and the total", () => {
    expect(eventTimingView(event, TURN_STARTED, asMs)).toEqual({
      stops: [
        { key: "occurred", label: "Occurred", value: `t=${OCCURRED}` },
        {
          key: "received",
          label: "Received",
          value: `t=${RECEIVED}`,
          waitSincePrevious: "2m",
        },
        {
          key: "turn-started",
          label: "Turn started",
          value: `t=${TURN_STARTED}`,
          waitSincePrevious: "40.0s",
        },
      ],
      totalWait: "2m 40s",
    });
  });

  it("shows a timestamp it cannot read as sent, with no wait from it and no total", () => {
    const view = eventTimingView(
      { ...event, timestamp: "yesterday at noon" },
      TURN_STARTED,
      asMs,
    );
    expect(view.stops[0]).toEqual({
      key: "occurred",
      label: "Occurred",
      value: "yesterday at noon",
      asSent: true,
    });
    expect(view.stops[1]).not.toHaveProperty("waitSincePrevious");
    expect(view.stops[2]?.waitSincePrevious).toBe("40.0s");
    expect(view).not.toHaveProperty("totalWait");
    expect(JSON.stringify(view)).not.toMatch(/NaN|-\d/);
  });

  it("shows no wait, and no total, where two clocks disagree", () => {
    // The server's clock is ahead of MCPJam's: it says the event occurred
    // after MCPJam received it.
    const view = eventTimingView(
      { ...event, timestamp: "2026-11-27T10:05:00.000Z" },
      TURN_STARTED,
      asMs,
    );
    expect(view.stops[0]?.value).toBe(`t=${Date.parse("2026-11-27T10:05:00.000Z")}`);
    expect(view.stops[1]).not.toHaveProperty("waitSincePrevious");
    expect(view.stops[2]?.waitSincePrevious).toBe("40.0s");
    expect(view).not.toHaveProperty("totalWait");

    // A test event received by the browser's clock, after the server's turn start.
    const late = eventTimingView(event, RECEIVED - 300, asMs);
    expect(late.stops[2]).toEqual({
      key: "turn-started",
      label: "Turn started",
      value: `t=${RECEIVED - 300}`,
    });
    expect(late).not.toHaveProperty("totalWait");
  });

  it("leaves out the stops it has no time for", () => {
    const { timestamp: _timestamp, ...untimed } = event;
    const view = eventTimingView(untimed, undefined, asMs);
    expect(view.stops).toEqual([
      { key: "received", label: "Received", value: `t=${RECEIVED}` },
    ]);
    expect(view).not.toHaveProperty("totalWait");
  });

  it("formats a wait like the timeline's latency under a minute, in minutes above it", () => {
    const wait = (ms: number) =>
      eventTimingView(event, RECEIVED + ms, asMs).stops[2]?.waitSincePrevious;
    expect(wait(12.6)).toBe("13ms");
    expect(wait(1_200)).toBe("1.20s");
    expect(wait(59_999)).toBe("60.0s");
    expect(wait(60_000)).toBe("1m");
    expect(wait(3_725_000)).toBe("1h 2m");
  });
});

describe("parseEventTimestamp", () => {
  it("reads an ISO 8601 date and time, and nothing vaguer", () => {
    expect(parseEventTimestamp("2026-11-27T10:00:00Z")).toBe(OCCURRED);
    expect(parseEventTimestamp("2026-11-27T11:00:00+01:00")).toBe(OCCURRED);
    expect(parseEventTimestamp("2026-11-27")).toBeUndefined();
    expect(parseEventTimestamp("1764237600")).toBeUndefined();
    expect(parseEventTimestamp("2026-13-45T99:99:99Z")).toBeUndefined();
  });

  it("refuses a day the month does not have, which Date.parse would roll over", () => {
    expect(Number.isFinite(Date.parse("2026-02-30T10:00:00Z"))).toBe(true);
    expect(parseEventTimestamp("2026-02-30T10:00:00Z")).toBeUndefined();
    expect(parseEventTimestamp("2026-04-31 10:00")).toBeUndefined();
    expect(parseEventTimestamp("2025-02-29T10:00:00Z")).toBeUndefined();
  });

  it("reads a leap day and an offset that moves the instant into the next month", () => {
    expect(parseEventTimestamp("2024-02-29T10:00:00Z")).toBe(
      Date.UTC(2024, 1, 29, 10),
    );
    expect(parseEventTimestamp("2026-02-28T23:30:00-05:00")).toBe(
      Date.UTC(2026, 2, 1, 4, 30),
    );
  });

  it("shows an impossible date as sent", () => {
    const view = eventTimingView(
      { ...event, timestamp: "2026-02-30T10:00:00Z" },
      TURN_STARTED,
      asMs,
    );
    expect(view.stops[0]).toEqual({
      key: "occurred",
      label: "Occurred",
      value: "2026-02-30T10:00:00Z",
      asSent: true,
    });
  });
});

describe("the prompt row and identifiers", () => {
  it("labels the row with the event's name and marks only a test event", () => {
    expect(eventPromptLabel(event)).toBe("Event: comment.created");
    expect(isTestEvent(event)).toBe(false);
    expect(isTestEvent({ ...event, origin: "simulation" })).toBe(true);
    expect(isTestEvent({ ...event, origin: "replay" })).toBe(false);
  });

  it("lists each identifier with a copy subject, and the delivery mode without one", () => {
    expect(eventIdentifierRows(event)).toEqual([
      { label: "Event ID", value: "evt_1", copySubject: "event ID" },
      { label: "Subscription", value: "esub_1", copySubject: "subscription ID" },
      { label: "Trigger", value: "trg_1", copySubject: "trigger ID" },
      { label: "Delivery", value: "Webhook" },
    ]);
    expect(
      eventIdentifierRows({ name: "x", receivedAt: 1, origin: "simulation" }),
    ).toEqual([]);
  });
});

describe("reading turnEvents off an envelope", () => {
  it("keys each valid entry by prompt index and drops the rest", () => {
    const map = traceTurnEventsByPromptIndex({
      turnEvents: [
        { promptIndex: 1, turnStartedAtMs: TURN_STARTED, event },
        { promptIndex: 2, event: { name: "x", receivedAt: "1", origin: "server" } },
        { promptIndex: "3", event },
        null,
      ],
    });
    expect([...(map?.keys() ?? [])]).toEqual([1]);
    expect(map?.get(1)).toEqual({
      promptIndex: 1,
      turnStartedAtMs: TURN_STARTED,
      event,
    });
  });

  it("is absent for an envelope with no event turns", () => {
    expect(traceTurnEventsByPromptIndex(null)).toBeUndefined();
    expect(traceTurnEventsByPromptIndex([])).toBeUndefined();
    expect(traceTurnEventsByPromptIndex({ turnEvents: [] })).toBeUndefined();
    expect(traceTurnEventsByPromptIndex({ spans: [] })).toBeUndefined();
  });
});

describe("turnEventsFromTurnTraces (Sessions detail)", () => {
  it("lists only the turns an event started, with each turn's start, in prompt order", () => {
    expect(
      turnEventsFromTurnTraces([
        { promptIndex: 2, startedAt: 30 },
        { promptIndex: 1, startedAt: TURN_STARTED, eventAtTurn: event },
        { promptIndex: 0, startedAt: 10 },
        { promptIndex: 3, startedAt: 40, eventAtTurn: { name: "" } },
      ]),
    ).toEqual([{ promptIndex: 1, turnStartedAtMs: TURN_STARTED, event }]);
    expect(turnEventsFromTurnTraces(undefined)).toEqual([]);
  });
});
