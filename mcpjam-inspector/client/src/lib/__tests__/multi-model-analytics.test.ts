import { describe, expect, it } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { isRebuiltLineup } from "../multi-model-analytics";

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;

function saved(preview: string, daysAgo: number): ChatHistorySession {
  return {
    _id: preview + daysAgo,
    chatSessionId: preview + daysAgo,
    firstMessagePreview: preview,
    status: "active",
    directVisibility: "private",
    messageCount: 2,
    version: 1,
    startedAt: now - daysAgo * DAY,
    lastActivityAt: now - daysAgo * DAY,
    isPinned: false,
    manualUnread: false,
    isUnread: false,
  };
}

describe("isRebuiltLineup", () => {
  it("is true when the prompt already ran in two recent chats", () => {
    const sessions = [saved("Find open bugs", 2), saved("Find open bugs", 2)];
    expect(isRebuiltLineup(" Find  open bugs ", now, sessions)).toBe(true);
  });

  it("is false for a longer prompt that only starts like a saved one", () => {
    const sessions = [saved("Find open bugs", 2), saved("Find open bugs", 2)];
    expect(
      isRebuiltLineup("Find open bugs assigned to me", now, sessions),
    ).toBe(false);
  });

  it("matches a long prompt against its cut preview", () => {
    const long = "a".repeat(250);
    const preview = "a".repeat(200);
    expect(
      isRebuiltLineup(long, now, [saved(preview, 1), saved(preview, 3)]),
    ).toBe(true);
  });

  it("is false for one earlier chat or chats older than 14 days", () => {
    expect(
      isRebuiltLineup("Find open bugs", now, [saved("Find open bugs", 1)]),
    ).toBe(false);
    expect(
      isRebuiltLineup("Find open bugs", now, [
        saved("Find open bugs", 20),
        saved("Find open bugs", 30),
      ]),
    ).toBe(false);
  });

  it("is false for an empty prompt", () => {
    expect(isRebuiltLineup("  ", now, [saved("", 1), saved("", 1)])).toBe(
      false,
    );
  });
});
