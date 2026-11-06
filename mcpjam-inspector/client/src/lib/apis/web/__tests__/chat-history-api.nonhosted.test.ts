import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import {
  chatHistoryAction,
  createChatHistoryWidgetSnapshot,
  getChatHistoryDetail,
  listChatHistory,
} from "../chat-history-api";

describe("chat history API in non-hosted mode", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
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

  it("fails a detail read whose caller aborted it while the body was downloading", async () => {
    // The pre-send sync's 15 s timeout can fire after the headers arrived.
    // That is a failed read, not an empty successful one.
    const timeout = new AbortController();
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => {
        timeout.abort(new DOMException("timed out", "TimeoutError"));
        return Promise.reject(timeout.signal.reason);
      },
    });

    await expect(
      getChatHistoryDetail(
        { chatSessionId: "chat-session-1" },
        { signal: timeout.signal },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
