import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import * as chatHistoryApi from "@/lib/apis/web/chat-history-api";
import { useChatHistory } from "../use-chat-history";

vi.mock("@/lib/apis/web/chat-history-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apis/web/chat-history-api")>();
  return {
    ...actual,
    listChatHistory: vi.fn(),
    chatHistoryAction: vi.fn(),
  };
});

function sessionStub(id: string): ChatHistorySession {
  return {
    _id: id,
    chatSessionId: `chat-${id}`,
    firstMessagePreview: "hi",
    status: "active",
    directVisibility: "private",
    messageCount: 1,
    version: 1,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    isPinned: false,
    manualUnread: false,
    isUnread: false,
  };
}

describe("useChatHistory archiveAllActive", () => {
  beforeEach(() => {
    vi.mocked(chatHistoryApi.listChatHistory).mockResolvedValue({
      ok: true,
      personal: [sessionStub("p1")],
      workspace: [sessionStub("w1")],
    });
    vi.mocked(chatHistoryApi.chatHistoryAction).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("archives all listed sessions then refetches once", async () => {
    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(chatHistoryApi.listChatHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.actions.archiveAllActive();
    });

    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledTimes(2);
    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledWith(
      "archive",
      "p1",
      undefined,
      expect.objectContaining({ headers: undefined }),
    );
    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledWith(
      "archive",
      "w1",
      undefined,
      expect.objectContaining({ headers: undefined }),
    );
    expect(chatHistoryApi.listChatHistory).toHaveBeenCalledTimes(2);
  });

  it("no-ops when there are no sessions", async () => {
    vi.mocked(chatHistoryApi.listChatHistory).mockResolvedValue({
      ok: true,
      personal: [],
      workspace: [],
    });

    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const listCallsBefore = vi.mocked(chatHistoryApi.listChatHistory).mock.calls
      .length;

    await act(async () => {
      await result.current.actions.archiveAllActive();
    });

    expect(chatHistoryApi.chatHistoryAction).not.toHaveBeenCalled();
    expect(chatHistoryApi.listChatHistory).toHaveBeenCalledTimes(
      listCallsBefore,
    );
  });
});
