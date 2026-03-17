import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistChatSessionToConvex } from "../chat-ingestion";

vi.mock("../logger", () => ({
  logger: {
    warn: vi.fn(),
  },
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
  });

  it("serializes sessionMessages when persisting a chat session", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-1",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      shareToken: "share-token",
      sourceType: "serverShare",
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
  });
});
