import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import {
  chatHistoryAction,
  createChatHistoryWidgetSnapshot,
  generateWidgetSnapshotUploadUrl,
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

  it("does not preempt authFetch's bearer when generating a widget snapshot upload URL", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, uploadUrl: "https://upload.test" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await generateWidgetSnapshotUploadUrl({ chatSessionId: "chat-session-1" });

    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");
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
