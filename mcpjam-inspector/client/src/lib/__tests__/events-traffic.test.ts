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

  it("names each row by the delivery mode that carried the entry", () => {
    logEventsFeedEntries(
      [entry(1, "push"), entry(2, "poll"), entry(3, "webhook"), entry(4, "push", "gap")],
      { feed: "local", resolveServer: () => ({ serverId: "Flights" }) },
    );
    const rows = useTrafficLogStore.getState().mcpServerItems;
    expect(rows.map((row) => row.method).sort()).toEqual([
      "poll event",
      "push event",
      "push gap",
      "webhook event",
    ]);
    expect(rows.every((row) => row.direction === "RECEIVE")).toBe(true);
  });
});
