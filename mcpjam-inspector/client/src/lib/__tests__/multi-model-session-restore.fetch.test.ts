import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";

const api = vi.hoisted(() => ({ group: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getMultiModelSessionGroup: api.group,
}));
vi.mock("@/components/chat-v2/history/chat-history-prefetch", () => ({
  getCachedChatHistoryDetail: api.detail,
}));

import { fetchMultiModelRestore } from "../multi-model-session-restore";

const column = (chatSessionId: string, position: number) =>
  ({
    _id: `row-${chatSessionId}`,
    chatSessionId,
    modelSelection: { source: "legacy", modelId: `openai/model-${position}` },
    messageCount: 2,
    multiModel: {
      groupId: "group-1",
      position,
      columnKind: "model",
      compareId: `model-${position}`,
    },
  }) as ChatHistorySession;

const sessions = [column("a", 0), column("b", 1)];
const restoreWith = () =>
  fetchMultiModelRestore({
    groupId: "group-1",
    projectId: "p1",
    selectedServers: ["live"],
    loadedSessions: sessions,
  });

describe("fetchMultiModelRestore", () => {
  beforeEach(() => {
    api.group.mockResolvedValue({ ok: true, groupId: "group-1", sessions });
    api.detail.mockReset();
  });

  it("brings back the servers the session was saved with", async () => {
    api.detail.mockResolvedValue({
      session: { resumeConfig: { selectedServers: ["linear", "github"] } },
    });
    const restored = await restoreWith();
    expect(restored?.record.selectedServers).toEqual(["linear", "github"]);
    expect(api.detail).toHaveBeenCalledWith({
      sessionId: "row-a",
      chatSessionId: "a",
      projectId: "p1",
    });
  });

  it("keeps the current servers when the session saved none", async () => {
    api.detail.mockResolvedValue({ session: {} });
    expect((await restoreWith())?.record.selectedServers).toEqual(["live"]);
  });

  it("keeps the current servers when the saved ones cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    api.detail.mockRejectedValue(new Error("offline"));
    expect((await restoreWith())?.record.selectedServers).toEqual(["live"]);
  });
});
