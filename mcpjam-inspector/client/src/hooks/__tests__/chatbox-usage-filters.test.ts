import { describe, expect, it } from "vitest";
import {
  compareThreadsForUsageList,
  threadMatchesUsageFilter,
} from "@/hooks/chatbox-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

function thread(
  overrides: Partial<SharedChatThread> & Pick<SharedChatThread, "_id">,
): SharedChatThread {
  return {
    sourceType: "chatbox",
    messageCount: 0,
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

describe("chatbox-usage-filters", () => {
  it("filters low ratings", () => {
    const low = thread({
      _id: "a",
      feedbackRating: 2,
      lastActivityAt: 100,
    });
    const high = thread({
      _id: "b",
      feedbackRating: 5,
      lastActivityAt: 200,
    });
    expect(threadMatchesUsageFilter(low, "low_ratings")).toBe(true);
    expect(threadMatchesUsageFilter(high, "low_ratings")).toBe(false);
  });

  it("filters no feedback", () => {
    const t = thread({
      _id: "a",
      feedbackRating: null,
      lastActivityAt: 1,
    });
    expect(threadMatchesUsageFilter(t, "no_feedback")).toBe(true);
  });

  it("sorts needs-review signals ahead", () => {
    const bad = thread({
      _id: "a",
      feedbackRating: 1,
      lastActivityAt: 10,
    });
    const good = thread({
      _id: "b",
      feedbackRating: 5,
      lastActivityAt: 999,
    });
    const sorted = [good, bad].sort(compareThreadsForUsageList);
    expect(sorted[0]?._id).toBe("a");
  });
});
