import { afterEach, describe, expect, it, vi } from "vitest";
import { compareBroadcastRecipient, createCompareBroadcast } from "../compare-broadcast";

const request = { id: 1, text: "read the viewer", prependMessages: [] };
const scope = {
  actorId: "actor", projectId: "project", chatSessionId: "chat", generation: 0,
  kind: "host" as const, hostId: "host", compareId: "host",
};
const recipient = compareBroadcastRecipient(scope);
afterEach(() => vi.useRealTimers());

describe("Compare broadcast delivery", () => {
  it("delivers once to each original lane only", () => {
    const delivery = createCompareBroadcast(request, [recipient, "second"]);
    expect(delivery.claim(request, "new-lane")).toBe(false);
    expect(delivery.claim({ ...request }, recipient)).toBe(false);
    expect(delivery.claim(request, recipient)).toBe(true);
    expect(delivery.claim(request, recipient)).toBe(false);
    expect(delivery.claim(request, "second")).toBe(true);
  });
  it.each([
    { actorId: "other" }, { projectId: "other" }, { chatSessionId: "other" },
    { generation: 1 }, { kind: "model" as const }, { hostId: "other" }, { compareId: "other" },
  ])("refuses a different recipient scope %j", (changed) => {
    const delivery = createCompareBroadcast(request, [recipient]);
    expect(delivery.claim(request, compareBroadcastRecipient({ ...scope, ...changed }))).toBe(false);
    expect(delivery.claim(request, recipient)).toBe(true);
  });
  it("expires an undelivered request without scheduling or replay", () => {
    vi.useFakeTimers();
    const delivery = createCompareBroadcast(request, [recipient]);
    vi.advanceTimersByTime(60_000);
    expect(delivery.claim(request, recipient)).toBe(false);
  });
});
