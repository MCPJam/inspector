import { describe, expect, it } from "vitest";
import {
  EVENT_AT_TURN_LIMITS,
  buildEventAtTurn,
  clipAtCodePoint,
  eventAtTurnFromFeedEntry,
  eventOriginAtTurn,
  readEventAtTurn,
} from "../event-at-turn";

/** U+1F600, two UTF-16 code units. */
const ASTRAL = "\u{1F600}";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("clipAtCodePoint", () => {
  it("returns a value within the limit unchanged", () => {
    expect(clipAtCodePoint("comment.created", 512)).toBe("comment.created");
    expect(clipAtCodePoint(`a${ASTRAL}`, 3)).toBe(`a${ASTRAL}`);
  });

  it("drops an astral character that would straddle the limit, never half of it", () => {
    // 511 ASCII units, then a pair at units 511 and 512: the pair does not fit
    // in 512, so it goes whole.
    const value = `${"a".repeat(511)}${ASTRAL}`;
    const clipped = clipAtCodePoint(value, EVENT_AT_TURN_LIMITS.name);
    expect(clipped).toBe("a".repeat(511));
    expect(hasLoneSurrogate(clipped)).toBe(false);
  });

  it("keeps an astral character that ends exactly at the limit", () => {
    const value = `${"a".repeat(510)}${ASTRAL}b`;
    const clipped = clipAtCodePoint(value, EVENT_AT_TURN_LIMITS.name);
    expect(clipped).toBe(`${"a".repeat(510)}${ASTRAL}`);
    expect(clipped).toHaveLength(512);
  });

  it("replaces a lone surrogate already in the value", () => {
    expect(clipAtCodePoint("a\ud800b", 10)).toBe("a�b");
    expect(clipAtCodePoint("\udc00", 10)).toBe("�");
    expect(hasLoneSurrogate(clipAtCodePoint("x\ud83d", 10))).toBe(false);
  });
});

describe("eventOriginAtTurn", () => {
  it.each(["webhook", "poll", "push"] as const)(
    "reads %s as the server's event with that delivery mode",
    (mode) => {
      expect(eventOriginAtTurn(mode, "poll")).toEqual({
        origin: "server",
        delivery: mode,
      });
    },
  );

  it.each(["simulation", "replay"] as const)(
    "keeps %s and takes the subscription's mode",
    (origin) => {
      expect(eventOriginAtTurn(origin, "webhook")).toEqual({
        origin,
        delivery: "webhook",
      });
    },
  );

  it.each(["simulation", "replay"] as const)(
    "leaves %s without a delivery mode when the subscription's is missing or unknown",
    (origin) => {
      expect(eventOriginAtTurn(origin, undefined)).toEqual({ origin });
      expect(eventOriginAtTurn(origin, "carrier-pigeon")).toEqual({ origin });
    },
  );

  it("reads an unknown or missing origin as the server's, with no delivery mode", () => {
    expect(eventOriginAtTurn("sse", "poll")).toEqual({ origin: "server" });
    expect(eventOriginAtTurn(undefined, "poll")).toEqual({ origin: "server" });
    expect(eventOriginAtTurn(null)).toEqual({ origin: "server" });
  });
});

describe("buildEventAtTurn", () => {
  it("clips every string and drops empty optional fields", () => {
    const event = buildEventAtTurn({
      name: "n".repeat(600),
      eventId: "i".repeat(2000),
      timestamp: "t".repeat(100),
      receivedAt: 1_700_000_000_000,
      origin: "webhook",
      subscriptionId: "s".repeat(300),
      triggerId: "",
    });
    expect(event).toEqual({
      name: "n".repeat(512),
      eventId: "i".repeat(1024),
      timestamp: "t".repeat(64),
      receivedAt: 1_700_000_000_000,
      delivery: "webhook",
      origin: "server",
      subscriptionId: "s".repeat(256),
    });
  });

  it("has nothing to name without a name or a receive time", () => {
    expect(
      buildEventAtTurn({ name: "", receivedAt: 1, origin: "poll" }),
    ).toBeUndefined();
    expect(
      buildEventAtTurn({ name: "x", receivedAt: Number.NaN, origin: "poll" }),
    ).toBeUndefined();
  });

  // The bounds of the backend's `parseEventAtTurn`: from the epoch to the last
  // time a `Date` holds.
  const MAX_DATE_MS = 8.64e15;

  it.each([0, 1.5, 1_700_000_000_000, MAX_DATE_MS])(
    "keeps a receive time the backend stores (%s)",
    (receivedAt) => {
      expect(
        buildEventAtTurn({ name: "x", receivedAt, origin: "poll" })?.receivedAt,
      ).toBe(receivedAt);
    },
  );

  it.each([
    -1,
    -MAX_DATE_MS,
    MAX_DATE_MS + 1,
    1e16,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("has nothing to name for a receive time the backend drops (%s)", (receivedAt) => {
    expect(
      buildEventAtTurn({ name: "x", receivedAt, origin: "poll" }),
    ).toBeUndefined();
  });
});

describe("eventAtTurnFromFeedEntry", () => {
  it("names the logical subscription and never a trigger", () => {
    expect(
      eventAtTurnFromFeedEntry(
        {
          name: "comment.created",
          eventId: "evt_1",
          timestamp: "2026-01-01T00:00:00Z",
          receivedAt: 42,
          origin: "simulation",
          logicalSubscriptionId: "esub_1",
        },
        "push",
      ),
    ).toEqual({
      name: "comment.created",
      eventId: "evt_1",
      timestamp: "2026-01-01T00:00:00Z",
      receivedAt: 42,
      delivery: "push",
      origin: "simulation",
      subscriptionId: "esub_1",
    });
  });
});

describe("readEventAtTurn", () => {
  const valid = {
    name: "comment.created",
    eventId: "evt_1",
    receivedAt: 42,
    delivery: "poll",
    origin: "simulation",
    subscriptionId: "esub_1",
    triggerId: "trg_1",
  };

  it("copies the record's own origin and delivery mode, and nothing else", () => {
    expect(
      readEventAtTurn({
        ...valid,
        _meta: { traceparent: "00-abc-def-01" },
        data: { secret: true },
      }),
    ).toEqual(valid);
  });

  it("treats null optional fields as absent", () => {
    expect(
      readEventAtTurn({
        name: "x",
        receivedAt: 1,
        origin: "server",
        delivery: null,
        eventId: null,
      }),
    ).toEqual({ name: "x", receivedAt: 1, origin: "server" });
  });

  it("refuses a value that is not a record", () => {
    expect(readEventAtTurn(undefined)).toBeUndefined();
    expect(readEventAtTurn("comment.created")).toBeUndefined();
    expect(readEventAtTurn({ ...valid, name: 7 })).toBeUndefined();
    expect(readEventAtTurn({ ...valid, name: "" })).toBeUndefined();
    expect(readEventAtTurn({ ...valid, receivedAt: "42" })).toBeUndefined();
    expect(readEventAtTurn({ ...valid, receivedAt: -1 })).toBeUndefined();
    expect(readEventAtTurn({ ...valid, receivedAt: 8.64e15 + 1 })).toBeUndefined();
    expect(readEventAtTurn({ ...valid, origin: "webhook" })).toBeUndefined();
    expect(readEventAtTurn({ ...valid, delivery: "sse" })).toBeUndefined();
    expect(readEventAtTurn({ ...valid, eventId: 7 })).toBeUndefined();
  });

  it("clips an over-long name instead of losing the label", () => {
    expect(
      readEventAtTurn({ ...valid, name: `${"a".repeat(511)}${ASTRAL}` })
        ?.name,
    ).toBe("a".repeat(511));
  });
});
