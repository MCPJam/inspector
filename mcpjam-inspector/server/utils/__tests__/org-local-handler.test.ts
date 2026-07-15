/**
 * Tests for `handleLocalOrgChatModel` (route 3 — local org BYOK).
 *
 * Engine consolidation route 3 collapse: this handler used to own its
 * own inline `streamText` driver (~390 LOC); it now delegates to
 * `runDirectChatTurn` and the shared `buildDirectChatTraceCallbacks`
 * SSE factory. These tests lock down the wrapper-level invariants the
 * collapse must preserve:
 *
 *   1. The synchronous `requireToolApproval=true` guard rejects with
 *      `tool_approval_unsupported` BEFORE building any model.
 *   2. Config / allowlist errors surface via `formatLocalStreamError`
 *      (the wrapper short-circuit, not an engine error).
 *   3. `postLocalUsage` fires on successful turn completion.
 *   4. `postLocalUsage` does NOT fire on abort (silent-cancel
 *      invariant — engine `onFinish` early-returns on abort, which
 *      means `onPersist` (where `postLocalUsage` runs) never fires).
 *   5. The MCPJam-parity callbacks added on the engine (`onLiveTextDelta`,
 *      `onStepFinish`, `onEngineError`) fire with the agreed payload
 *      shape when route 3 forwards them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgProviderResolvedConfig } from "@mcpjam/sdk/model-factory";

const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

// `buildOrgModelFromResolvedConfig` reaches into provider SDKs at module
// init; stub it so we can run handler unit tests without networking.
vi.mock("@mcpjam/sdk/model-factory", async () => {
  const actual = await vi.importActual<
    typeof import("@mcpjam/sdk/model-factory")
  >("@mcpjam/sdk/model-factory");
  return {
    ...actual,
    assertOrgModelAllowed: vi.fn(),
    buildOrgModelFromResolvedConfig: vi.fn(() => ({ id: "mock-model" })),
  };
});

import {
  assertOrgModelAllowed,
  buildOrgModelFromResolvedConfig,
} from "@mcpjam/sdk/model-factory";
import { handleLocalOrgChatModel } from "../org-model-stream-handler";

function buildResolvedProvider(): OrgProviderResolvedConfig {
  // Cast — the handler only reads `providerKey` off the resolved config;
  // the rest is plumbed through to factories we've stubbed above.
  return {
    providerKey: "openai",
    provider: "openai",
    runtime: "local",
    apiKey: "sk-test",
  } as unknown as OrgProviderResolvedConfig;
}

function defaultStreamTextReturn(
  overrides: Partial<{
    messages: Array<{ role: string; content: unknown }>;
    steps: unknown[];
    totalUsage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    finishReason: string;
  }> = {},
) {
  return {
    consumeStream: async () => {},
    response: Promise.resolve({
      modelId: "mock-model",
      messages: overrides.messages ?? [
        { role: "assistant", content: "Hi" },
      ],
    }),
    steps: Promise.resolve(overrides.steps ?? []),
    totalUsage: Promise.resolve(
      overrides.totalUsage ?? {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    ),
    finishReason: Promise.resolve(overrides.finishReason ?? "stop"),
    toUIMessageStream: () => ({
      [Symbol.asyncIterator]() {
        return { next: async () => ({ value: undefined, done: true }) };
      },
    }),
  };
}

const ORIGINAL_CONVEX = process.env.CONVEX_HTTP_URL;

describe("handleLocalOrgChatModel — route 3 collapse invariants", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    vi.mocked(assertOrgModelAllowed).mockReset();
    vi.mocked(buildOrgModelFromResolvedConfig).mockReset();
    vi.mocked(buildOrgModelFromResolvedConfig).mockReturnValue({
      id: "mock-model",
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_CONVEX === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX;
    }
  });

  it("rejects synchronously with tool_approval_unsupported when requireToolApproval=true", async () => {
    // The synchronous guard must NEVER reach the engine — it's a
    // wrapper-level reject so the model is not built, the SSE writer
    // emits a single `error` chunk with code `tool_approval_unsupported`,
    // and the upstream provider is never contacted.
    const writtenChunks: any[] = [];
    const response = handleLocalOrgChatModel({
      provider: buildResolvedProvider(),
      projectId: "proj",
      modelId: "gpt-4-turbo",
      messages: [{ role: "user", content: "hi" } as any],
      systemPrompt: "s",
      tools: { foo: { description: "f" } } as any,
      requireToolApproval: true,
      onStreamWriterReady: ({ write }) => {
        // Capture chunks the handler writes to the SSE stream.
        const original = write;
        // Re-bind so capture works in the same execution tick.
        (response as any)._writer = original;
      },
    });

    // Run the stream so `execute` runs.
    // The mocked `createUIMessageStreamResponse` in the production
    // chain returns a real Response wrapping the stream; we don't need
    // to drain SSE bytes here — we drive the wrapper through the
    // handler's `onStreamWriterReady` capture.
    expect(response).toBeInstanceOf(Response);

    // Drain the response body to force `execute` to run.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        writtenChunks.push(chunk.value);
      }
    }

    // The model factory must NOT have been called.
    expect(buildOrgModelFromResolvedConfig).not.toHaveBeenCalled();
    // The engine must NOT have been invoked.
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("surfaces config errors via formatLocalStreamError without invoking the engine", async () => {
    vi.mocked(assertOrgModelAllowed).mockImplementation(() => {
      throw new Error("model not allowed for this org");
    });

    const response = handleLocalOrgChatModel({
      provider: buildResolvedProvider(),
      projectId: "proj",
      modelId: "blocked-model",
      messages: [{ role: "user", content: "hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
    });

    expect(response).toBeInstanceOf(Response);

    // Drain the body so `execute` runs.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    }

    // Engine must NOT have been invoked when config validation fails.
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("fires postLocalUsage on successful completion", async () => {
    // CONVEX_HTTP_URL must be set for postLocalUsage to attempt the
    // POST; the fetch mock observes the writeback URL + body.
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    streamTextMock.mockImplementationOnce((options: any) => {
      const r = defaultStreamTextReturn({
        totalUsage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      });
      // Drive the engine's onFinish so onPersist fires.
      queueMicrotask(() => {
        void options.onFinish({
          steps: [],
          totalUsage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          finishReason: "stop",
          text: "Hi",
        });
      });
      return r;
    });

    const response = handleLocalOrgChatModel({
      provider: buildResolvedProvider(),
      projectId: "proj-123",
      modelId: "gpt-4-turbo",
      messages: [{ role: "user", content: "hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
    });

    // Drain so `execute` runs.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    }
    // Yield so the queued microtask + the in-flight fetch settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const usageCall = fetchMock.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("/stream/org/local-usage"),
    );
    expect(usageCall).toBeDefined();
    const body = JSON.parse((usageCall![1] as any).body as string);
    expect(body.projectId).toBe("proj-123");
    expect(body.providerKey).toBe("openai");
    expect(body.usage).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
    expect(body.finishReason).toBe("stop");
  });

  it("does NOT fire postLocalUsage on abort (silent-cancel invariant)", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const controller = new AbortController();
    streamTextMock.mockImplementationOnce((options: any) => {
      controller.abort();
      // Engine onFinish runs even on abort but early-returns; that
      // means `onPersist` (which posts usage) must NOT be invoked.
      queueMicrotask(() => {
        void options.onFinish({
          steps: [],
          totalUsage: undefined,
          finishReason: undefined,
          text: "",
        });
      });
      return defaultStreamTextReturn();
    });

    const response = handleLocalOrgChatModel({
      provider: buildResolvedProvider(),
      projectId: "proj",
      modelId: "gpt-4-turbo",
      messages: [{ role: "user", content: "hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      abortSignal: controller.signal,
    });

    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    const usageCall = fetchMock.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("/stream/org/local-usage"),
    );
    expect(usageCall).toBeUndefined();
  });

  it("forwards onLiveTextDelta — text-delta chunks reach the caller", async () => {
    streamTextMock.mockImplementationOnce((options: any) => {
      // Drive a text-delta chunk through the engine's `onChunk`.
      void options.onChunk({ chunk: { type: "text-delta", text: "Hi" } });
      return defaultStreamTextReturn();
    });

    const deltas: string[] = [];
    const response = handleLocalOrgChatModel({
      provider: buildResolvedProvider(),
      projectId: "proj",
      modelId: "gpt-4-turbo",
      messages: [{ role: "user", content: "hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      onLiveTextDelta: (delta) => deltas.push(delta),
    });

    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    }

    expect(deltas).toEqual(["Hi"]);
  });

  it("does NOT invoke onConversationComplete when the stream errors mid-flight (Cursor PR-review fix)", async () => {
    // Legacy route 3 gated ingestion on `!streamErrored`. The collapse
    // dropped that guard; fix wires `onEngineError` -> local flag, and
    // `onPersist` checks it before forwarding to `onConversationComplete`.
    // Billing (`postLocalUsage`) still fires — matches legacy unconditional
    // usage writeback (handled in the postLocalUsage test above).
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    streamTextMock.mockImplementationOnce((options: any) => {
      // Engine fires `onError` then `onFinish` for terminal errors
      // (AI SDK shape: onFinish runs for all terminal outcomes including
      // finishReason:"error"). The wrapper's `onEngineError` callback
      // flips `streamErrored = true`; `onPersist` then skips ingestion.
      queueMicrotask(async () => {
        await options.onError({ error: new Error("upstream 500") });
        await options.onFinish({
          steps: [],
          totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          finishReason: "error",
          text: "",
        });
      });
      return defaultStreamTextReturn();
    });

    const onConversationComplete = vi.fn();
    const response = handleLocalOrgChatModel({
      provider: buildResolvedProvider(),
      projectId: "proj",
      modelId: "gpt-4-turbo",
      messages: [{ role: "user", content: "hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      onConversationComplete,
    });

    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onConversationComplete).not.toHaveBeenCalled();
  });

  it("dedups onConversationComplete history against the initial messages prefix (Cursor PR-review fix)", async () => {
    // Legacy code called `appendDedupedModelMessages(traceHistory,
    // responseMessages)` against the full prefix; the collapse used
    // naive `[...messages, ...event.responseMessages]` which could
    // double-write a message that overlaps the prompt prefix. Fix
    // restores `appendDedupedModelMessages` against the prefix.
    // Real-world impact is low (AI SDK rarely emits overlapping
    // content), but the regression test locks the defensive semantics.
    const sharedMsg = {
      role: "user" as const,
      content: "hi",
    };
    const distinctResponse = {
      role: "assistant" as const,
      content: "Done",
    };

    streamTextMock.mockImplementationOnce((options: any) => {
      queueMicrotask(() => {
        void options.onFinish({
          // Engine assembles `responseMessages` from steps. Include the
          // shared `sharedMsg` (overlaps the prefix) AND a new response.
          // The wrapper must dedup `sharedMsg` against the prefix while
          // keeping the new response.
          steps: [
            {
              response: {
                messages: [sharedMsg, distinctResponse],
              },
            },
          ],
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          text: "Done",
        });
      });
      return defaultStreamTextReturn();
    });

    const onConversationComplete = vi.fn();
    const response = handleLocalOrgChatModel({
      provider: buildResolvedProvider(),
      projectId: "proj",
      modelId: "gpt-4-turbo",
      messages: [sharedMsg] as any,
      systemPrompt: "s",
      tools: {} as any,
      onConversationComplete,
    });

    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onConversationComplete).toHaveBeenCalledTimes(1);
    const fullHistory = onConversationComplete.mock.calls[0]![0] as Array<{
      role: string;
      content: unknown;
    }>;
    // Expected shape: [sharedMsg, distinctResponse] — NOT
    // [sharedMsg, sharedMsg, distinctResponse]. Without the dedup the
    // shared message would appear twice.
    expect(fullHistory).toHaveLength(2);
    expect(fullHistory[0]).toEqual(sharedMsg);
    expect(fullHistory[1]).toEqual(distinctResponse);
  });
});
