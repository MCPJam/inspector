/**
 * Stage 1 contract tests for `runAssistantTurn`.
 *
 * Verifies the documented return shape for both
 * `streamSink: "none" + persistMode: "caller"` (synthetic-runner mode)
 * and the live-chat fields it threads through to the engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { runAssistantTurn } from "../assistant-turn";
import type { ModelDefinition } from "@/shared/types";

let lastExecution: Promise<void> | null = null;
let writtenChunks: any[] = [];

const buildSsePayload = (events: any[]) =>
  `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;

const createSseResponse = (events: any[]) => {
  const encoder = new TextEncoder();
  const payload = buildSsePayload(events);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = {
        write: vi.fn((chunk) => {
          writtenChunks.push(chunk);
        }),
      };
      // Return a ReadableStream whose `start` runs `execute` and then
      // `onFinish` before closing. This matches the real AI SDK
      // contract: draining the body drives the agent loop to
      // completion. The synthetic-runner path (streamSink: "none")
      // drains the body, so by the time `runAssistantTurn` returns the
      // captured transcript is populated.
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          lastExecution = Promise.resolve(execute({ writer })).then(
            async () => {
              await onFinish?.();
            }
          );
          await lastExecution;
          controller.close();
        },
      });
      return stream;
    }),
    createUIMessageStreamResponse: vi.fn().mockImplementation(({ stream }) => {
      return new Response(stream as ReadableStream<Uint8Array>, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }),
  };
});

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn(),
}));

vi.mock("../chat-helpers", async () => {
  const actual = await vi.importActual<typeof import("../chat-helpers")>(
    "../chat-helpers"
  );
  return {
    ...actual,
    scrubMcpAppsToolResultsForBackend: vi.fn((messages) => messages),
    scrubChatGPTAppsToolResultsForBackend: vi.fn((messages) => messages),
  };
});

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

const baseModelDefinition: ModelDefinition = {
  id: "openai/gpt-oss-120b",
  provider: "openai",
  name: "GPT OSS 120B",
} as ModelDefinition;

describe("runAssistantTurn", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    writtenChunks = [];
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("returns the documented transcript shape for streamSink:none + persistMode:caller", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Hi there." },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      ])
    );

    const result = runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      authContext: { kind: "service_token", token: "Bearer test-token" },
      sourceType: "chatbox",
      approvalMode: "auto-deny",
      streamSink: "none",
      persistMode: "caller",
      synthesisRunId: "run_abc",
      synthesisJobId: "job_xyz",
    });

    // `runAssistantTurn` awaits the engine completion internally.
    const resolved = await result;
    await lastExecution;

    // Synthetic-runner mode does NOT return a Hono Response.
    expect(resolved.response).toBeUndefined();
    expect(resolved.messages).toBeDefined();
    expect(Array.isArray(resolved.messages)).toBe(true);
    expect(resolved.assistantMessages).toBeDefined();
    expect(Array.isArray(resolved.assistantMessages)).toBe(true);
    expect(resolved.toolCalls).toEqual([]);
    expect(resolved.toolResults).toEqual([]);

    // The engine's onConversationComplete tap fires regardless of
    // persistMode — the synthetic runner reads back the trace via the
    // returned struct.
    expect(resolved.turnTrace).toBeDefined();
    expect(resolved.turnTrace?.turnId).toEqual(expect.any(String));
    expect(resolved.turnTrace?.modelId).toBe("openai/gpt-oss-120b");
    expect(resolved.finishReason).toBe("stop");
    expect(resolved.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });

    // synthesisRunId / synthesisJobId are threaded into the /stream
    // request body so Convex spend wiring can attribute usage.
    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
    );
    expect(fetchBody.synthesisRunId).toBe("run_abc");
    expect(fetchBody.synthesisJobId).toBe("job_xyz");
  });

  it("returns a Response when streamSink:ui and threads through to the engine", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
    );

    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      authContext: { kind: "user_bearer", token: "Bearer user-token" },
      sourceType: "direct",
      streamSink: "ui",
      persistMode: "handler",
    });

    await lastExecution;

    // UI mode hands the Hono Response back so the route can return it.
    expect(result.response).toBeInstanceOf(Response);
  });

  it("does NOT call the caller's onConversationComplete in persistMode:caller", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
    );

    const onConversationComplete = vi.fn();

    await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      authContext: { kind: "service_token", token: "Bearer service" },
      sourceType: "chatbox",
      streamSink: "none",
      persistMode: "caller",
      onConversationComplete,
    });

    await lastExecution;

    expect(onConversationComplete).not.toHaveBeenCalled();
  });

  it("DOES call the caller's onConversationComplete in persistMode:handler", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
    );

    const onConversationComplete = vi.fn();

    await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      authContext: { kind: "user_bearer", token: "Bearer user" },
      sourceType: "direct",
      streamSink: "ui",
      persistMode: "handler",
      onConversationComplete,
    });

    await lastExecution;

    expect(onConversationComplete).toHaveBeenCalledTimes(1);
  });
});
