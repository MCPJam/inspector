import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectChatLiveTurnPublisher } from "../direct-chat-live-turn.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("createDirectChatLiveTurnPublisher", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site/";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries non-2xx writes and sends the latest assistant text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const publisher = createDirectChatLiveTurnPublisher({
      authHeader: "Bearer token",
      chatSessionId: "session-1",
      projectId: "project-1",
      modelId: "model-1",
      modelSource: "mcpjam",
      directVisibility: "project",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(publisher).not.toBeNull();
    publisher?.appendText("hi there");
    await publisher?.complete();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.convex.site/direct-chat/live-turn",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      chatSessionId: "session-1",
      projectId: "project-1",
      promptText: "hello",
      assistantText: "hi there",
      status: "complete",
      modelId: "model-1",
      modelSource: "mcpjam",
      directVisibility: "project",
    });
  });

  it("aborts hanging writes so completion does not hang", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const publisher = createDirectChatLiveTurnPublisher({
      authHeader: "Bearer token",
      chatSessionId: "session-1",
      projectId: "project-1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(publisher).not.toBeNull();
    publisher?.appendText("partial");
    const completePromise = publisher?.complete();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(completePromise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
