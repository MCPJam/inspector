import { describe, expect, it } from "vitest";
import { WebRouteError } from "../../../routes/web/errors.js";
import { eventAtTurnFromBody } from "../event-at-turn-body.js";

describe("eventAtTurnFromBody", () => {
  it("is absent when the request carries none", () => {
    expect(eventAtTurnFromBody(undefined)).toBeUndefined();
    expect(eventAtTurnFromBody(null)).toBeUndefined();
  });

  it("keeps the record's fields and leaves everything else behind", () => {
    expect(
      eventAtTurnFromBody({
        name: "comment.created",
        eventId: "evt_1",
        timestamp: "2026-01-01T00:00:00Z",
        receivedAt: 42,
        delivery: "webhook",
        origin: "server",
        subscriptionId: "esub_1",
        _meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
        data: { text: "hello" },
      }),
    ).toEqual({
      name: "comment.created",
      eventId: "evt_1",
      timestamp: "2026-01-01T00:00:00Z",
      receivedAt: 42,
      delivery: "webhook",
      origin: "server",
      subscriptionId: "esub_1",
    });
  });

  it("clips an over-long id at a code-point boundary instead of refusing it", () => {
    const event = eventAtTurnFromBody({
      name: "x",
      eventId: `${"a".repeat(1023)}\u{1F600}`,
      receivedAt: 1,
      origin: "simulation",
    });
    expect(event?.eventId).toBe("a".repeat(1023));
  });

  it.each([0, 8.64e15])("accepts a receive time at the backend's bound (%s)", (receivedAt) => {
    expect(
      eventAtTurnFromBody({ name: "x", receivedAt, origin: "server" })?.receivedAt,
    ).toBe(receivedAt);
  });

  it.each([
    ["a string", "comment.created"],
    ["no name", { receivedAt: 1, origin: "server" }],
    ["a receive time that is not a number", { name: "x", receivedAt: "1", origin: "server" }],
    ["a receive time before the epoch", { name: "x", receivedAt: -1, origin: "server" }],
    ["a receive time past the last date", { name: "x", receivedAt: 1e16, origin: "server" }],
    ["a delivery mode as its origin", { name: "x", receivedAt: 1, origin: "webhook" }],
    ["an unknown delivery mode", { name: "x", receivedAt: 1, origin: "server", delivery: "sse" }],
  ])("refuses %s with a 400", (_label, body) => {
    try {
      eventAtTurnFromBody(body);
      expect.unreachable("a malformed event must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(WebRouteError);
      expect((error as WebRouteError).status).toBe(400);
    }
  });
});
