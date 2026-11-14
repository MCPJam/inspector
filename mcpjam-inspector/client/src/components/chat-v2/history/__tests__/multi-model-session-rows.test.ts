import { describe, expect, it } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import {
  foldMultiModelSessions,
  multiModelLineupLabel,
} from "../multi-model-session-rows";

function row(
  id: string,
  multiModel?: { groupId: string; position: number; removedAt?: number },
): ChatHistorySession {
  return {
    _id: id,
    chatSessionId: id,
    firstMessagePreview: id,
    status: "active",
    directVisibility: "private",
    messageCount: 2,
    version: 1,
    startedAt: 1,
    lastActivityAt: 1,
    isPinned: false,
    manualUnread: false,
    isUnread: false,
    ...(multiModel
      ? {
          multiModel: {
            ...multiModel,
            columnKind: "model" as const,
            compareId: id,
          },
        }
      : {}),
  };
}

describe("foldMultiModelSessions", () => {
  it("folds a group into one entry where its newest column sat", () => {
    const entries = foldMultiModelSessions([
      row("single-1"),
      row("b", { groupId: "g", position: 1 }),
      row("single-2"),
      row("a", { groupId: "g", position: 0 }),
    ]);
    expect(entries.map((e) => (e.kind === "group" ? e.groupId : e.session._id))).toEqual([
      "single-1",
      "g",
      "single-2",
    ]);
  });

  it("leads with the lowest live column and lists removed ones last", () => {
    const [entry] = foldMultiModelSessions([
      row("a", { groupId: "g", position: 0, removedAt: 9 }),
      row("c", { groupId: "g", position: 2 }),
      row("b", { groupId: "g", position: 1 }),
    ]);
    if (entry.kind !== "group") throw new Error("expected a group");
    expect(entry.lead._id).toBe("b");
    expect(entry.columns.map((c) => c._id)).toEqual(["b", "c", "a"]);
    expect(multiModelLineupLabel(entry, (s) => s._id.toUpperCase())).toBe(
      "2 models · B, C",
    );
  });

  it("keeps a group with one saved column as a plain row", () => {
    const entries = foldMultiModelSessions([row("a", { groupId: "g", position: 0 })]);
    expect(entries).toEqual([{ kind: "session", session: expect.objectContaining({ _id: "a" }) }]);
  });
});

describe("foldMultiModelSessions with columns from outside the page", () => {
  it("adds them to their group without listing them as rows", () => {
    const onPage = [row("a", { groupId: "g", position: 0 }), row("single")];
    const sibling = row("b", { groupId: "g", position: 1 });
    const entries = foldMultiModelSessions([...onPage, sibling], onPage);
    expect(entries).toHaveLength(2);
    const [group] = entries;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.columns.map((c) => c._id)).toEqual(["a", "b"]);
  });
});
