import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import {
  buildDirectHostConfig,
  persistChatSessionToConvex,
} from "../chat-ingestion";
import type { RequestLogContext } from "../log-events";

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  event: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

// Mirror the production envelope populated by requestLogContextMiddleware.
// Without this, getRequestLogger throws — the strict-throw was added in the
// typed-event foundation to surface wiring bugs, so test fixtures must reflect
// real production wiring.
function makeTestContext(): Context {
  const baseContext: RequestLogContext = {
    event: "http.request.completed",
    timestamp: "2024-01-01T00:00:00.000Z",
    environment: "test",
    release: null,
    component: "http",
    requestId: "test-req",
    route: "/api/web/test",
    method: "POST",
    authType: "unknown",
  };
  const vars: Record<string, unknown> = { requestLogContext: baseContext };
  return {
    var: new Proxy(vars, { get: (t, p) => t[p as string] }),
    set: vi.fn((key: string, value: unknown) => {
      vars[key] = value;
    }),
  } as unknown as Context;
}

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
      expect.stringContaining(
        "[chat-session-persistence] Failed to persist chat session (500):",
      ),
      expect.objectContaining({
        status: 500,
        responsePreview: expect.any(String),
      }),
    );

    const [message, metadata] = mockLogger.warn.mock.calls[0];
    expect(message).toContain("[redacted-secret]");
    expect(message).toContain("[redacted-email]");
    expect(message).toContain("Bearer [redacted-token]");
    expect(message).not.toContain("support@example.com");
    expect(message).not.toContain("super-secret-token");
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

  it("logs version conflicts explicitly", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: "VERSION_CONFLICT",
          currentVersion: 7,
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await persistChatSessionToConvex({
      chatSessionId: "session-4",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      startedAt: 1,
      expectedVersion: 6,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[chat-session-persistence] Chat session version conflict",
      expect.objectContaining({
        status: 409,
        responsePreview: expect.stringContaining("VERSION_CONFLICT"),
      }),
    );
  });

  it("emits chat.session.persist.failed(version_conflict) via typed event when c is provided", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "VERSION_CONFLICT" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const c = makeTestContext();

    await persistChatSessionToConvex(
      {
        chatSessionId: "evt-1",
        modelId: "m",
        modelSource: "mcpjam",
        authHeader: "Bearer t",
        startedAt: 1,
        sourceType: "chatbox",
      },
      c,
    );

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "version_conflict" }),
      undefined,
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("emits chat.session.persist.failed(http_error) via typed event when c is provided", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("Server Error", { status: 503 }),
    );
    const c = makeTestContext();

    await persistChatSessionToConvex(
      {
        chatSessionId: "evt-2",
        modelId: "m",
        modelSource: "mcpjam",
        authHeader: "Bearer t",
        startedAt: 1,
        sourceType: "direct",
      },
      c,
    );

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "http_error", statusCode: 503 }),
      undefined,
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("emits chat.session.persist.failed(timeout) via typed event when c is provided", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockImplementation(
      async (_input, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal instanceof AbortSignal) {
            signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }
        }),
    ) as typeof fetch;
    const c = makeTestContext();

    const p = persistChatSessionToConvex(
      {
        chatSessionId: "evt-3",
        modelId: "m",
        modelSource: "mcpjam",
        authHeader: "Bearer t",
        startedAt: 1,
        timeoutMs: 50,
      },
      c,
    );
    await vi.advanceTimersByTimeAsync(50);
    await p;

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "timeout" }),
      undefined,
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("emits chat.session.persist.failed(exception) via typed event when c is provided", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network failure"));
    const c = makeTestContext();

    await persistChatSessionToConvex(
      {
        chatSessionId: "evt-4",
        modelId: "m",
        modelSource: "mcpjam",
        authHeader: "Bearer t",
        startedAt: 1,
      },
      c,
    );

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "exception" }),
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("forwards hostConfig verbatim when present on direct chats", async () => {
    const hostConfig = {
      hostStyle: "direct" as const,
      systemPrompt: "you are helpful",
      modelId: "openai/gpt-4o-mini",
      temperature: 0.4,
      requireToolApproval: true,
      selectedServerIds: ["server-a", "server-b"],
    };

    await persistChatSessionToConvex({
      chatSessionId: "session-host-config",
      modelId: "openai/gpt-4o-mini",
      modelSource: "byok",
      authHeader: "Bearer bearer-token",
      sourceType: "direct",
      startedAt: 1,
      hostConfig,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect(body.hostConfig).toEqual(hostConfig);
  });

  it("omits hostConfig from the request body when not provided", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-host-config-omit",
      modelId: "openai/gpt-4o-mini",
      modelSource: "byok",
      authHeader: "Bearer bearer-token",
      sourceType: "direct",
      startedAt: 1,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect("hostConfig" in body).toBe(false);
  });

  it("includes directVisibility when persisting a direct chat", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-5",
      modelId: "openai/gpt-5-mini",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      sourceType: "direct",
      directVisibility: "project",
      startedAt: 1,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect(body.sourceType).toBe("direct");
    expect(body.directVisibility).toBe("project");
  });
});

describe("buildDirectHostConfig", () => {
  it("falls back to requestedTemperature when resolvedTemperature is undefined (GPT-5 path)", () => {
    const config = buildDirectHostConfig({
      modelId: "openai/gpt-5",
      systemPrompt: "hi",
      requestedTemperature: 0.4,
      resolvedTemperature: undefined,
      requireToolApproval: false,
      selectedServerIds: ["a"],
    });

    expect(config.temperature).toBe(0.4);
    expect(typeof config.temperature).toBe("number");
  });

  it("falls back to 0.7 when both temperatures are undefined", () => {
    const config = buildDirectHostConfig({
      modelId: "openai/gpt-5",
    });

    expect(config.temperature).toBe(0.7);
  });

  it("coerces undefined systemPrompt to empty string", () => {
    const config = buildDirectHostConfig({
      modelId: "openai/gpt-4o",
      systemPrompt: undefined,
    });

    expect(config.systemPrompt).toBe("");
  });

  it("coerces undefined selectedServerIds to empty array", () => {
    const config = buildDirectHostConfig({
      modelId: "openai/gpt-4o",
    });

    expect(config.selectedServerIds).toEqual([]);
  });

  it("coerces non-true requireToolApproval to false", () => {
    const truthy = buildDirectHostConfig({
      modelId: "openai/gpt-4o",
      requireToolApproval: true,
    });
    const undef = buildDirectHostConfig({
      modelId: "openai/gpt-4o",
      requireToolApproval: undefined,
    });

    expect(truthy.requireToolApproval).toBe(true);
    expect(undef.requireToolApproval).toBe(false);
  });

  it("emits hostStyle 'direct' and the provided modelId", () => {
    const config = buildDirectHostConfig({
      modelId: "anthropic/claude-haiku-4.5",
      systemPrompt: "p",
      resolvedTemperature: 0.2,
      selectedServerIds: ["x", "y"],
      requireToolApproval: true,
    });

    expect(config).toEqual({
      hostStyle: "direct",
      systemPrompt: "p",
      modelId: "anthropic/claude-haiku-4.5",
      temperature: 0.2,
      requireToolApproval: true,
      selectedServerIds: ["x", "y"],
    });
  });
});
