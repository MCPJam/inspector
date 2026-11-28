import { beforeEach, describe, expect, it } from "vitest";
import type { EventsFeedEntryView } from "@/shared/events-api";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { logEventsFeedEntries } from "../events-traffic";

const entry = (
  seq: number,
  origin: EventsFeedEntryView["origin"],
  kind = "event",
): EventsFeedEntryView => ({
  seq,
  kind,
  origin,
  namespace: "live",
  logicalSubscriptionId: "esub_1",
  receivedAt: Date.UTC(2026, 10, 24),
});

describe("logEventsFeedEntries", () => {
  beforeEach(() => useTrafficLogStore.getState().clear());

  it("names each row by its delivery mode and event type", () => {
    const named = (
      seq: number,
      origin: EventsFeedEntryView["origin"],
    ): EventsFeedEntryView => ({
      ...entry(seq, origin),
      name: "flight.status_changed",
    });
    logEventsFeedEntries(
      [named(1, "push"), named(2, "poll"), named(3, "webhook"), entry(4, "push", "gap")],
      { feed: "local", resolveServer: () => ({ serverId: "Flights" }) },
    );
    const rows = useTrafficLogStore.getState().mcpServerItems;
    expect(rows.map((row) => row.method).sort()).toEqual([
      "poll event · flight.status_changed",
      "push event · flight.status_changed",
      "push gap",
      "webhook event · flight.status_changed",
    ]);
    expect(rows.every((row) => row.direction === "RECEIVE")).toBe(true);
  });
});
