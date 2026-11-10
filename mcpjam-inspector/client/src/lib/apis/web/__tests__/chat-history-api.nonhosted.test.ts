import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import {
  chatHistoryAction,
  createChatHistoryWidgetSnapshot,
  getChatHistoryDetail,
  getChatHistoryState,
  listChatHistory,
} from "../chat-history-api";

describe("chat history API in non-hosted mode", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  it("requests current state without replacing the full history read", async () => {
    const controller = new AbortController();
    mockAuthFetch.mockImplementation(async () => new Response(JSON.stringify({
      ok: true, session: { _id: "session-1", version: 4, directVisibility: "private" },
    }), { status: 200 }));
    const params = { sessionId: "session-1", chatSessionId: "chat-1", projectId: "project-1" };
    const result = await getChatHistoryState(params, { signal: controller.signal });
    expect(result.session.version).toBe(4);
    expect(mockAuthFetch).toHaveBeenLastCalledWith(
      "/api/web/chat-history/detail?sessionId=session-1&chatSessionId=chat-1&projectId=project-1&view=state",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
    await getChatHistoryDetail(params);
    expect(mockAuthFetch).toHaveBeenLastCalledWith(
      "/api/web/chat-history/detail?sessionId=session-1&chatSessionId=chat-1&projectId=project-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("lets authFetch choose the bearer when listing history", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, personal: [], project: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await listChatHistory({ status: "active", projectId: "ws-1" });

    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/chat-history/list?projectId=ws-1&status=active",
      expect.objectContaining({
        method: "GET",
      }),
    );

    expect(mockAuthFetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("does not preempt authFetch's bearer when posting an action", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await chatHistoryAction("mark-read", "session-1");

    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/chat-history/action",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );

    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves an explicit authorization header", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, personal: [], project: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await listChatHistory(
      { status: "active" },
      { headers: { Authorization: "Bearer explicit-token" } },
    );

    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer explicit-token");
  });

  it("forwards an abort signal when reading history detail", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, session: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const controller = new AbortController();

    await getChatHistoryDetail(
      { chatSessionId: "chat-session-1" },
      { signal: controller.signal },
    );

    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/chat-history/detail?chatSessionId=chat-session-1",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("does not preempt authFetch's bearer when creating a widget snapshot", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, snapshotId: "snapshot-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await createChatHistoryWidgetSnapshot({
      chatSessionId: "chat-session-1",
      toolCallId: "call-1",
      toolName: "search",
      widgetHtmlBlobId: "blob-1",
      uiType: "mcp-apps",
    });

    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");
  });
});
