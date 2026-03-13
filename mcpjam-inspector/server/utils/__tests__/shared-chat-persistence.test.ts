import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveThreadToConvex } from "../shared-chat-persistence";

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

describe("shared-chat-persistence", () => {
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

  it("serializes reasoning parts when saving shared chat threads", async () => {
    await saveThreadToConvex({
      chatSessionId: "session-1",
      shareToken: "share-token",
      bearerToken: "bearer-token",
      messageCount: 1,
      modelId: "openai/gpt-oss-120b",
      messages: [
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
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect(body.messages[0].content).toEqual([
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
