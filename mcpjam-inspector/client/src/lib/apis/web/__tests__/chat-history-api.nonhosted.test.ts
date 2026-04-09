import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.hoisted(() => vi.fn());
const mockGetGuestBearerToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: (...args: unknown[]) => mockGetGuestBearerToken(...args),
}));

import {
  chatHistoryAction,
  listChatHistory,
  upsertChatHistoryDraft,
} from "../chat-history-api";

describe("chat history API in non-hosted mode", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
    mockGetGuestBearerToken.mockReset();
    mockGetGuestBearerToken.mockResolvedValue("guest-token");
  });

  it("attaches the guest bearer when listing history", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, personal: [], workspace: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await listChatHistory({ status: "active", workspaceId: "ws-1" });

    expect(mockGetGuestBearerToken).toHaveBeenCalledTimes(1);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/chat-history/list?workspaceId=ws-1&status=active",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );

    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer guest-token");
  });

  it("attaches the guest bearer when posting an action", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await chatHistoryAction("mark-read", "session-1");

    expect(mockGetGuestBearerToken).toHaveBeenCalledTimes(1);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/chat-history/action",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );

    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer guest-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("attaches the guest bearer when saving a draft", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          session: {
            _id: "session-1",
            chatSessionId: "chat-session-1",
            firstMessagePreview: "hello",
            status: "active",
            directVisibility: "private",
            messageCount: 0,
            version: 1,
            startedAt: 1,
            lastActivityAt: 1,
            isPinned: false,
            manualUnread: false,
            isUnread: false,
            messagesBlobUrl: "https://storage.test/blob",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await upsertChatHistoryDraft({
      chatSessionId: "chat-session-1",
      firstMessagePreview: "hello",
      resumeConfig: { draftInput: "hello" },
    });

    expect(mockGetGuestBearerToken).toHaveBeenCalledTimes(1);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/chat-history/draft",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );

    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer guest-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves an explicit authorization header", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, personal: [], workspace: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await listChatHistory(
      { status: "active" },
      { headers: { Authorization: "Bearer explicit-token" } },
    );

    expect(mockGetGuestBearerToken).not.toHaveBeenCalled();
    const headers = mockAuthFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer explicit-token");
  });
});
