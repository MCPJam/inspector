import { describe, expect, it } from "vitest";
import {
  relayEventMetadata,
  MAX_EVENT_AGE_MS,
  MAX_EVENT_FUTURE_MS,
} from "../relay-event-metadata";

const now = Date.parse("2026-10-13T12:00:00.000Z");
const uuid = "019a0000-0000-7000-8000-000000000001";
describe("strict event metadata", () => {
  it("mints an opaque retry-stable UUID without forwarding the caller's ID", () => {
    const event = { uuid, timestamp: new Date(now - 1000).toISOString() };
    const first = relayEventMetadata(event, now);
    expect(first).toEqual(relayEventMetadata(event, now + 100));
    expect(first.uuid).not.toBe(uuid);
    expect(first.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      relayEventMetadata({ ...event, uuid: uuid.toUpperCase() }, now),
    ).toEqual(first);
    expect(
      relayEventMetadata(
        { ...event, uuid: "019a0000-0000-7000-8000-000000000002" },
        now,
      ).uuid,
    ).not.toBe(first.uuid);
  });
  it.each(["CUSTOMER_SENTINEL", null, {}, undefined])(
    "replaces invalid ID %s with a server ID",
    (value) => {
      const first = relayEventMetadata({ uuid: value }, now);
      expect(first.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.uuid).not.toBe(
        relayEventMetadata({ uuid: value }, now).uuid,
      );
      expect(first.timestamp).toBe(new Date(now).toISOString());
    },
  );
  it.each([-MAX_EVENT_AGE_MS, MAX_EVENT_FUTURE_MS])(
    "accepts bounded client time at %i",
    (offset) => {
      const timestamp = new Date(now + offset).toISOString();
      expect(relayEventMetadata({ timestamp }, now).timestamp).toBe(timestamp);
    },
  );
  it.each([
    "CUSTOMER_SENTINEL",
    {},
    null,
    new Date(now - MAX_EVENT_AGE_MS - 1).toISOString(),
    new Date(now + MAX_EVENT_FUTURE_MS + 1).toISOString(),
  ])("replaces invalid or out-of-window time %s", (timestamp) => {
    expect(relayEventMetadata({ timestamp }, now).timestamp).toBe(
      new Date(now).toISOString(),
    );
  });
});
