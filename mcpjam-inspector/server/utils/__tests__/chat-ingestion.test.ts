import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistChatSessionToConvex } from "../chat-ingestion";

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

describe("chat-ingestion", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
    vi.useRealTimers();
  });

  it("serializes sessionMessages when persisting a chat session", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-1",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      shareToken: "share-token",
      sourceType: "serverShare",
      surface: "share_link",
      sessionMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Need to inspect the saved trace payload.",
              state: "done",
            },
            {
              type: "text",
              text: "Saved trace response",
            },
          ],
        },
      ] as any,
      startedAt: 1,
      lastActivityAt: 2,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect(body.sessionMessages[0].content).toEqual([
      {
        type: "reasoning",
        text: "Need to inspect the saved trace payload.",
        state: "done",
      },
      {
        type: "text",
        text: "Saved trace response",
      },
    ]);
    expect(body.surface).toBe("share_link");
  });

  it("logs a bounded sanitized response preview on ingest failures", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        [
          "token=super-secret-token",
          "contact support@example.com",
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          "message=".concat("x".repeat(300)),
        ].join("\n"),
        {
          status: 500,
        },
      ),
    );

    await persistChatSessionToConvex({
      chatSessionId: "session-2",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      startedAt: 1,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[chat-session-persistence] Failed to persist chat session",
      expect.objectContaining({
        status: 500,
        responsePreview: expect.any(String),
      }),
    );

    const [, metadata] = mockLogger.warn.mock.calls[0];
    expect(metadata.responsePreview).toContain("[redacted-secret]");
    expect(metadata.responsePreview).toContain("[redacted-email]");
    expect(metadata.responsePreview).toContain("Bearer [redacted-token]");
    expect(metadata.responsePreview).not.toContain("support@example.com");
    expect(metadata.responsePreview).not.toContain("super-secret-token");
    expect(metadata.responsePreview.length).toBeLessThanOrEqual(203);
  });

  it("aborts slow ingest requests after the configured timeout", async () => {
    vi.useFakeTimers();

    global.fetch = vi.fn().mockImplementation(
      async (_input, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("Missing abort signal"));
            return;
          }

          signal.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("The operation was aborted."), {
                name: "AbortError",
              }),
            );
          });
        }),
    ) as typeof fetch;

    const persistPromise = persistChatSessionToConvex({
      chatSessionId: "session-3",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      startedAt: 1,
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await persistPromise;

    expect(global.fetch).toHaveBeenCalledWith(
      "https://test-convex.example.com/ingest-chat",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[chat-session-persistence] Timed out persisting chat session",
      {
        timeoutMs: 50,
      },
    );
  });
});
