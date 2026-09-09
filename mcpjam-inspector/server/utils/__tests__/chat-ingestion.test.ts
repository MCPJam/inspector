import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import {
  buildDirectHostConfig,
  buildPersistReceiptData,
  persistChatSessionToConvex,
  stampSenderUserIdsOnSessionMessages,
  writePersistReceipt,
} from "../chat-ingestion";
import { PERSIST_RECEIPT_PART_TYPE } from "../../../shared/persist-receipt";
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
      })
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
      scenarioId: "cbx_test",
      sourceType: "scenario",
      origin: "scenario",
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

  it("keeps the sent prompt and the resume prompt as separate fields", async () => {
    // Two different questions, and merging them breaks one of the two:
    // `systemPrompt` is EVIDENCE of what the model was given (turn-injected
    // sections included), `resumeConfig.systemPrompt` is what a resumed turn
    // replays. Replaying turn-injected content — a skills catalog for servers
    // that may no longer be connected, or a "your sandbox was reset" notice —
    // is the confabulation the raw resume prompt exists to prevent.
    await persistChatSessionToConvex({
      chatSessionId: "session-2",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      sourceType: "direct",
      origin: "playground",
      systemPrompt: "HOST PROMPT\n\n## Skills from MCP servers\n\n- **acme/refunds**",
      resumeConfig: { systemPrompt: "HOST PROMPT" },
      startedAt: 1,
      lastActivityAt: 2,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect(body.systemPrompt).toContain("## Skills from MCP servers");
    expect(body.resumeConfig.systemPrompt).toBe("HOST PROMPT");
  });

  it("serializes rewind lineage for an edited branch", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "branch-session",
      modelId: "openai/gpt-4.1-mini",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      projectId: "project-1",
      sourceType: "direct",
      origin: "playground",
      rewind: {
        parentChatSessionId: "original-session",
        rewoundFromMessageId: "user-message-2",
        reason: "message_edit",
      },
      sessionMessages: [],
      startedAt: 1,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect(body.rewind).toEqual({
      parentChatSessionId: "original-session",
      rewoundFromMessageId: "user-message-2",
      reason: "message_edit",
    });
  });

  it("stamps senderUserId onto persisted user messages only for the authenticated user", () => {
    const sessionMessages = [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "internal context" },
      { role: "user", content: "second" },
    ];
    const sourceMessages = [
      { role: "system", parts: [{ type: "text", text: "system" }] },
      {
        role: "user",
        parts: [{ type: "text", text: "first" }],
        metadata: { senderUserId: "u-alice" },
      },
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        parts: [{ type: "text", text: "internal context" }],
        metadata: { source: "widget-model-context" },
      },
      {
        role: "user",
        parts: [{ type: "text", text: "second" }],
        senderUserId: "u-bob",
      },
    ];

    const stamped = stampSenderUserIdsOnSessionMessages(
      sessionMessages,
      sourceMessages,
      { authenticatedUserId: "u-alice" }
    );

    expect(stamped).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "first", senderUserId: "u-alice" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "internal context" },
      { role: "user", content: "second" },
    ]);
  });

  it("ignores client-supplied senderUserId when no trusted principal is available", () => {
    const sessionMessages = [{ role: "user", content: "hello" }];
    const sourceMessages = [
      {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        metadata: { senderUserId: "u-alice" },
      },
    ];

    const stamped = stampSenderUserIdsOnSessionMessages(
      sessionMessages,
      sourceMessages
    );

    expect(stamped).toBe(sessionMessages);
  });

  it("logs a bounded sanitized response preview on ingest failures", async () => {
    vi.useFakeTimers();
    // A fresh Response per call: 5xx is retried, and a real fetch never hands
    // back the same already-consumed body twice.
    global.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          [
            "token=super-secret-token",
            "contact support@example.com",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            "message=".concat("x".repeat(300)),
          ].join("\n"),
          {
            status: 500,
          }
        )
    ) as typeof fetch;

    const persistPromise = persistChatSessionToConvex({
      chatSessionId: "session-2",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await persistPromise;

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[chat-session-persistence] Failed to persist chat session (500):"
      ),
      expect.objectContaining({
        status: 500,
        responsePreview: expect.any(String),
      })
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
              })
            );
          });
        })
    ) as typeof fetch;

    const persistPromise = persistChatSessionToConvex({
      chatSessionId: "session-3",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
      timeoutMs: 50,
    });

    // Long enough to cover all three attempts and both backoffs.
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await persistPromise;

    expect(outcome).toEqual({ outcome: "failed", failureKind: "timeout" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://test-convex.example.com/ingest-chat",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[chat-session-persistence] Timed out persisting chat session",
      {
        timeoutMs: 50,
      }
    );
    // Logged once at the end, not once per attempt.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("gives each retry its own AbortController", async () => {
    // A single controller shared across attempts stays aborted forever, so
    // every retry would fail instantly with the timeout that killed the first.
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    global.fetch = vi
      .fn()
      .mockImplementation(async (_input, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        if (signals.length < 3) {
          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" })
              );
            });
          });
        }
        return new Response(JSON.stringify({ ok: true, version: 4 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

    const persistPromise = persistChatSessionToConvex({
      chatSessionId: "session-retry",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await persistPromise).toEqual({ outcome: "saved", version: 4 });
    expect(signals).toHaveLength(3);
    expect(signals[0]).not.toBe(signals[2]);
    expect(signals[2].aborted).toBe(false);
  });

  it("does not retry a 409", async () => {
    global.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "VERSION_CONFLICT",
            currentVersion: 9,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        )
    ) as typeof fetch;

    const outcome = await persistChatSessionToConvex({
      chatSessionId: "session-409",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
      expectedVersion: 3,
    });

    expect(outcome).toEqual({ outcome: "conflict", currentVersion: 9 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx that is not a conflict", async () => {
    global.fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response("bad request", { status: 400 })
      ) as typeof fetch;

    const outcome = await persistChatSessionToConvex({
      chatSessionId: "session-400",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
    });

    expect(outcome).toEqual({
      outcome: "failed",
      failureKind: "http_error",
      status: 400,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
        }
      )
    );

    await persistChatSessionToConvex({
      chatSessionId: "session-4",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
      expectedVersion: 6,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[chat-session-persistence] Chat session version conflict",
      expect.objectContaining({
        status: 409,
        responsePreview: expect.stringContaining("VERSION_CONFLICT"),
      })
    );
  });

  it("emits chat.session.persist.failed(version_conflict) via typed event when c is provided", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "VERSION_CONFLICT" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    );
    const c = makeTestContext();

    await persistChatSessionToConvex(
      {
        chatSessionId: "evt-1",
        modelId: "m",
        modelSource: "mcpjam",
        authHeader: "Bearer t",
        startedAt: 1,
        sourceType: "scenario",
        origin: "scenario",
      },
      c
    );

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "version_conflict" }),
      undefined
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("emits chat.session.persist.failed(http_error) via typed event when c is provided", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Server Error", { status: 503 }));
    const c = makeTestContext();

    await persistChatSessionToConvex(
      {
        chatSessionId: "evt-2",
        modelId: "m",
        modelSource: "mcpjam",
        authHeader: "Bearer t",
        startedAt: 1,
        sourceType: "direct",
        origin: "playground",
      },
      c
    );

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "http_error", statusCode: 503 }),
      undefined
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
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" })
              );
            });
          }
        })
    ) as typeof fetch;
    const c = makeTestContext();

    const p = persistChatSessionToConvex(
      {
        chatSessionId: "evt-3",
        modelId: "m",
        modelSource: "mcpjam",
        authHeader: "Bearer t",
        origin: "playground",
        startedAt: 1,
        timeoutMs: 50,
      },
      c
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await p;

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "timeout" }),
      undefined
    );
    expect(mockLogger.event).toHaveBeenCalledTimes(1);
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
        origin: "playground",
        startedAt: 1,
      },
      c
    );

    expect(mockLogger.event).toHaveBeenCalledWith(
      "chat.session.persist.failed",
      expect.any(Object),
      expect.objectContaining({ failureKind: "exception" }),
      expect.objectContaining({ error: expect.any(Error) })
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  describe("outcome mapping", () => {
    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const persist = () =>
      persistChatSessionToConvex({
        chatSessionId: "outcome-session",
        modelId: "openai/gpt-oss-120b",
        modelSource: "mcpjam",
        authHeader: "Bearer bearer-token",
        origin: "playground",
        startedAt: 1,
      });

    it("maps a committed write to saved", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ok: true, skipped: false, version: 12 })
        ) as typeof fetch;

      expect(await persist()).toEqual({ outcome: "saved", version: 12 });
    });

    it("maps a recognized duplicate turn to duplicate, not skipped", async () => {
      // A retry whose first response was lost. As good as saved — the client
      // must not be told its turn went missing.
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          skipped: true,
          duplicateTurn: true,
          version: 12,
        })
      ) as typeof fetch;

      expect(await persist()).toEqual({ outcome: "duplicate", version: 12 });
    });

    it("maps a bare skip to skipped — a possible lost turn", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ok: true, skipped: true, version: 5 })
        ) as typeof fetch;

      expect(await persist()).toEqual({ outcome: "skipped", version: 5 });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("replay")
      );
    });

    it("maps a 2xx with no version to protocol_error, never a fabricated save", async () => {
      // The client syncs its concurrency baseline from this version; inventing
      // one would hand it a baseline that 409s on the very next send.
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ ok: true })) as typeof fetch;

      expect(await persist()).toEqual({
        outcome: "failed",
        failureKind: "protocol_error",
        status: 200,
      });
    });

    it("maps an unparseable 2xx body to protocol_error", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("not json at all", { status: 200 })
        ) as typeof fetch;

      expect(await persist()).toEqual({
        outcome: "failed",
        failureKind: "protocol_error",
        status: 200,
      });
    });

    it("retries a 2xx whose body read is cut off by the attempt timeout", async () => {
      // The abort signal covers body streaming, so a slow 2xx body can be cut
      // off mid-read. That is a timeout worth retrying, not a malformed
      // response — the write may well have committed.
      vi.useFakeTimers();
      let attempt = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw Object.assign(new Error("aborted"), {
                name: "AbortError",
              });
            },
          } as unknown as Response;
        }
        return new Response(JSON.stringify({ ok: true, version: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const persistPromise = persistChatSessionToConvex({
        chatSessionId: "abort-body",
        modelId: "openai/gpt-oss-120b",
        modelSource: "mcpjam",
        authHeader: "Bearer bearer-token",
        origin: "playground",
        startedAt: 1,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await persistPromise).toEqual({ outcome: "saved", version: 3 });
      expect(attempt).toBe(2);
    });

    it("keeps the response preview on a 4xx so the failure is diagnosable", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("modelId is required", { status: 400 })
        ) as typeof fetch;

      await persistChatSessionToConvex({
        chatSessionId: "bad-request",
        modelId: "openai/gpt-oss-120b",
        modelSource: "mcpjam",
        authHeader: "Bearer bearer-token",
        origin: "playground",
        startedAt: 1,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("modelId is required"),
        expect.objectContaining({ status: 400 })
      );
    });

    it("carries the 4xx preview into the typed event too", async () => {
      // The request-context path is what production actually logs through, so
      // the detail has to survive there and not just in the fallback logger.
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("modelId is required", { status: 400 })
        ) as typeof fetch;
      const c = makeTestContext();

      await persistChatSessionToConvex(
        {
          chatSessionId: "bad-request",
          modelId: "openai/gpt-oss-120b",
          modelSource: "mcpjam",
          authHeader: "Bearer bearer-token",
          origin: "playground",
          startedAt: 1,
        },
        c
      );

      expect(mockLogger.event).toHaveBeenCalledWith(
        "chat.session.persist.failed",
        expect.any(Object),
        expect.objectContaining({
          failureKind: "http_error",
          statusCode: 400,
          responsePreview: expect.stringContaining("modelId is required"),
        }),
        undefined
      );
    });

    it("reports not-attempted without a session id, auth, or Convex URL", async () => {
      const base = {
        modelId: "openai/gpt-oss-120b",
        modelSource: "mcpjam" as const,
        origin: "playground" as const,
        startedAt: 1,
      };

      expect(
        await persistChatSessionToConvex({
          ...base,
          chatSessionId: "",
          authHeader: "Bearer t",
        })
      ).toEqual({ outcome: "not-attempted", reason: "no-session-id" });

      expect(
        await persistChatSessionToConvex({ ...base, chatSessionId: "s" })
      ).toEqual({ outcome: "not-attempted", reason: "no-auth" });

      delete process.env.CONVEX_HTTP_URL;
      expect(
        await persistChatSessionToConvex({
          ...base,
          chatSessionId: "s",
          authHeader: "Bearer t",
        })
      ).toEqual({ outcome: "not-attempted", reason: "no-convex-url" });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  it("sends the turn trace's turnId as the top-level idempotency key", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, version: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    await persistChatSessionToConvex({
      chatSessionId: "turnid-session",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
      turnTrace: {
        turnId: "turn-abc",
        promptIndex: 0,
        startedAt: 1,
        endedAt: 2,
        spans: [],
        modelId: "openai/gpt-oss-120b",
      },
    });

    const body = JSON.parse(
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
        .body as string
    );
    expect(body.turnId).toBe("turn-abc");
    expect(body.turnTrace.turnId).toBe("turn-abc");
  });

  it("carries the turn's skill/environment provenance on the wire", async () => {
    // The provenance rides INSIDE `turnTrace`, which `buildIngestBody`
    // serializes whole — so this reaches the backend with no edit to the body
    // builder's field spread. If someone "fixes" that by adding the fields
    // there too, this test still passes and the duplication is dead weight;
    // what it guards is that the fields arrive at all.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, version: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    const turnTrace = {
      turnId: "turn-prov",
      promptIndex: 0,
      startedAt: 1,
      endedAt: 2,
      spans: [],
      modelId: "openai/gpt-oss-120b",
      skillsAtTurn: [
        {
          skillId: "sk_1",
          projectSkillVersionNumber: 3,
          versionPinned: true,
          name: "refunds",
          contentHash: "h1",
          sharing: "project",
          channels: ["environment"],
        },
      ],
      environmentAtTurn: {
        environmentId: "env_1",
        name: "Pinned arm",
        revision: 4,
      },
    };

    await persistChatSessionToConvex({
      chatSessionId: "prov-session",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
      turnTrace,
    });

    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.turnTrace.skillsAtTurn).toEqual(turnTrace.skillsAtTurn);
    expect(body.turnTrace.environmentAtTurn).toEqual(
      turnTrace.environmentAtTurn
    );
  });

  it("omits turnId for a traceless payload so the legacy path is unchanged", async () => {
    // Its own fetch mock: reading `mock.calls[0]` off an inherited one makes the
    // assertion depend on suite order rather than on this request.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, version: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    await persistChatSessionToConvex({
      chatSessionId: "traceless-session",
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      origin: "playground",
      startedAt: 1,
    });

    const body = JSON.parse(
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
        .body as string
    );
    expect(body).not.toHaveProperty("turnId");
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
      origin: "playground",
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
      origin: "playground",
      startedAt: 1,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect("hostConfig" in body).toBe(false);
  });

  it("posts to /ingest-chat with the bearer authorization header", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-user-default",
      modelId: "openai/gpt-4o-mini",
      modelSource: "byok",
      authHeader: "Bearer bearer-token",
      sourceType: "direct",
      origin: "playground",
      startedAt: 1,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = (global.fetch as any).mock.calls[0];
    expect(url).toBe("https://test-convex.example.com/ingest-chat");
    const headers = request.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer bearer-token");
  });

  it("includes directVisibility when persisting a direct chat", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-5",
      modelId: "openai/gpt-5-mini",
      modelSource: "mcpjam",
      authHeader: "Bearer bearer-token",
      sourceType: "direct",
      origin: "playground",
      directVisibility: "project",
      startedAt: 1,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect(body.sourceType).toBe("direct");
    expect(body.directVisibility).toBe("project");
  });

  it("serializes targetId onto the ingest body for per-target (environment) attribution", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-env-target",
      modelId: "openai/gpt-4o-mini",
      modelSource: "byok",
      authHeader: "Bearer bearer-token",
      sourceType: "swarm",
      origin: "swarm",
      journeyRunId: "run-1",
      hostId: "host-1",
      targetId: "target-a",
      startedAt: 1,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    // Two environment targets can share ONE host, so `hostId` alone cannot
    // attribute the session — `targetId` must reach the backend.
    expect(body.hostId).toBe("host-1");
    expect(body.targetId).toBe("target-a");
  });

  it("omits targetId from the ingest body when not supplied (legacy host targets)", async () => {
    await persistChatSessionToConvex({
      chatSessionId: "session-legacy-target",
      modelId: "openai/gpt-4o-mini",
      modelSource: "byok",
      authHeader: "Bearer bearer-token",
      sourceType: "swarm",
      origin: "swarm",
      journeyRunId: "run-1",
      hostId: "host-1",
      startedAt: 1,
    });

    const request = (global.fetch as any).mock.calls[0]?.[1];
    const body = JSON.parse((request?.body as string) ?? "{}");

    expect("targetId" in body).toBe(false);
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

  it("includes respectToolVisibility in Convex hostConfig payloads", () => {
    const config = buildDirectHostConfig({
      modelId: "anthropic/claude-haiku-4.5",
      systemPrompt: "p",
      resolvedTemperature: 0.7,
      selectedServerIds: ["x"],
      requireToolApproval: false,
      respectToolVisibility: false,
    });

    expect(config.respectToolVisibility).toBe(false);
  });

  it("includes MCP image rendering policy in Convex hostConfig payloads", () => {
    const config = buildDirectHostConfig({
      modelId: "anthropic/claude-haiku-4.5",
      resolvedTemperature: 0.7,
      mcpToolResultImageRendering: {
        placement: "collapsed",
        linkedResources: { blob: { image: false } },
      },
    });

    expect(config.mcpToolResultImageRendering).toEqual({
      placement: "collapsed",
      linkedResources: { blob: { image: false } },
    });
  });

  it("defaults hostStyle to 'claude' when omitted (Phase 3 read switch)", () => {
    // Phase 3: legacy `'direct'` is no longer the default. Callers
    // that used to omit hostStyle now get 'claude' so new direct chat
    // traces produce v2 hostConfigs with a real host style. Backend
    // accepts the legacy literal `'direct'` for one deploy and
    // normalizes with a `legacy_direct_style` warn.
    const config = buildDirectHostConfig({
      modelId: "anthropic/claude-haiku-4.5",
      systemPrompt: "p",
      resolvedTemperature: 0.2,
      selectedServerIds: ["x", "y"],
      requireToolApproval: true,
    });

    expect(config).toEqual({
      hostStyle: "claude",
      systemPrompt: "p",
      modelId: "anthropic/claude-haiku-4.5",
      temperature: 0.2,
      requireToolApproval: true,
      selectedServerIds: ["x", "y"],
    });
  });

  it("forwards an explicit hostStyle (e.g. 'chatgpt') from the chat tab", () => {
    const config = buildDirectHostConfig({
      modelId: "openai/gpt-5-mini",
      hostStyle: "chatgpt",
      systemPrompt: "",
      resolvedTemperature: 0.7,
      selectedServerIds: [],
      requireToolApproval: false,
    });
    expect(config.hostStyle).toBe("chatgpt");
  });
});

describe("persist receipt", () => {
  const context = { chatSessionId: "session-1", turnId: "turn-1" };

  it("maps each outcome onto the wire shape the client reads", () => {
    expect(
      buildPersistReceiptData({ outcome: "saved", version: 4 }, context)
    ).toEqual({
      outcome: "saved",
      chatSessionId: "session-1",
      turnId: "turn-1",
      version: 4,
    });
    expect(
      buildPersistReceiptData({ outcome: "duplicate", version: 4 }, context)
    ).toMatchObject({ outcome: "duplicate", version: 4 });
    expect(
      buildPersistReceiptData(
        { outcome: "conflict", currentVersion: 9 },
        context
      )
    ).toMatchObject({ outcome: "conflict", currentVersion: 9 });
    expect(
      buildPersistReceiptData(
        { outcome: "failed", failureKind: "timeout" },
        context
      )
    ).toMatchObject({ outcome: "failed", failureKind: "timeout" });
  });

  it("emits nothing for not-attempted", () => {
    // Nothing was tried, so there is nothing to report; a receipt here would
    // make the client believe a save was evaluated when it never happened.
    expect(
      buildPersistReceiptData(
        { outcome: "not-attempted", reason: "no-auth" },
        context
      )
    ).toBeNull();

    const writer = { write: vi.fn() };
    writePersistReceipt(
      writer,
      { outcome: "not-attempted", reason: "no-auth" },
      context
    );
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("writes a transient data part", () => {
    const writer = { write: vi.fn() };
    writePersistReceipt(writer, { outcome: "saved", version: 2 }, context);

    expect(writer.write).toHaveBeenCalledWith({
      type: PERSIST_RECEIPT_PART_TYPE,
      data: {
        outcome: "saved",
        chatSessionId: "session-1",
        turnId: "turn-1",
        version: 2,
      },
      transient: true,
    });
  });

  it("swallows a write into an already-closed stream", () => {
    // Finalization must not reject because the client hung up; a missing
    // receipt degrades to the client's subscription fallback.
    const writer = {
      write: vi.fn(() => {
        throw new Error("stream closed");
      }),
    };

    expect(() =>
      writePersistReceipt(writer, { outcome: "saved", version: 2 }, context)
    ).not.toThrow();
  });
});
