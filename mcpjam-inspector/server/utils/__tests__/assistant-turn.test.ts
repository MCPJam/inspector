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

const { runHarnessTurnMock } = vi.hoisted(() => ({
  runHarnessTurnMock: vi.fn(),
}));

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

// The harness arm, stubbed so this suite can see WHICH engine the dispatch
// chose. Without it a sentinel turn would try to reserve a real computer, and
// the only assertion available would be about the emulated engine's fetch —
// which cannot tell "ran the harness" from "refused".
vi.mock("../harness/run-harness-turn.js", () => ({
  runHarnessTurn: runHarnessTurnMock,
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    // Stubbed so the emulated-engine path is fully drivable from this suite:
    // without it, a turn that reaches the engine dies on a missing mock method,
    // and a test asserting "no engine ran" would pass for the wrong reason.
    event: vi.fn(),
    systemEvent: vi.fn(),
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
      authContext: { kind: "user_bearer", token: "Bearer test-token" },
      sourceType: "scenario",
      origin: "scenario",
      approvalMode: "auto-deny",
      streamSink: "none",
      persistMode: "caller",
      extraBodyFields: { journeyRunId: "run_abc" },
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

    // extraBodyFields (the swarm journeyRunId attribution channel) are
    // threaded into the /stream request body so Convex spend wiring can
    // attribute usage.
    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
    );
    expect(fetchBody.journeyRunId).toBe("run_abc");
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
      origin: "playground",
      streamSink: "ui",
      persistMode: "handler",
    });

    await lastExecution;

    // UI mode hands the Hono Response back so the route can return it.
    expect(result.response).toBeInstanceOf(Response);
  });

  it("carries the caller's persist outcome through to the receipt on the wire", async () => {
    // The wrapper used to await `onConversationComplete` and drop what it
    // returned, which made `undefined` mean both "this caller reports nothing"
    // and "the outcome was lost in transit" — and the engine reads the first,
    // so a failed ingest would have looked saved.
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
    );

    await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      authContext: { kind: "user_bearer", token: "Bearer user-token" },
      sourceType: "direct",
      origin: "playground",
      chatSessionId: "assistant-turn-session",
      streamSink: "ui",
      persistMode: "handler",
      onConversationComplete: async () => ({
        outcome: "failed" as const,
        failureKind: "timeout" as const,
      }),
    });

    await lastExecution;

    expect(
      writtenChunks.find((chunk) => chunk?.type === "data-persist-receipt")
    ).toMatchObject({
      data: {
        outcome: "failed",
        failureKind: "timeout",
        chatSessionId: "assistant-turn-session",
      },
    });
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
      authContext: { kind: "user_bearer", token: "Bearer service" },
      sourceType: "scenario",
      origin: "scenario",
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
      origin: "playground",
      streamSink: "ui",
      persistMode: "handler",
      onConversationComplete,
    });

    await lastExecution;

    expect(onConversationComplete).toHaveBeenCalledTimes(1);
  });

  /**
   * THE DISPATCH GATE, and the one place where "model ineligible" must not mean
   * "run the emulated engine instead".
   *
   * `useHarness = harnessRequested && modelEligible` is a silent degrade by
   * design: a brokered harness handed a model MCPJam does not host falls back
   * to the emulated engine, which runs exactly that model on org BYOK. Sound
   * there, and the opposite of sound for an external-account harness — the
   * emulated engine cannot run a sentinel at all, so what the fallback produces
   * is a swarm or eval turn that completes, reports success, and is recorded
   * under `executionEngineLabel` = `harness:cursor` having never run Cursor.
   *
   * This is the path with no pre-flight: the interactive rails fail closed at
   * `checkHarnessRuntimeAvailable`, but `sessionSimulation/runner.ts` drives
   * turns straight through here.
   */
  describe("external-account harness dispatch", () => {
    const turn = (modelDefinition: ModelDefinition, harness: string) =>
      runAssistantTurn({
        messages: [{ role: "user", content: "Hi." }] as any,
        modelDefinition,
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        authContext: { kind: "user_bearer", token: "Bearer test-token" },
        sourceType: "swarm",
        origin: "scenario",
        approvalMode: "auto-deny",
        streamSink: "none",
        persistMode: "caller",
        harness: harness as any,
      });

    it("REFUSES an ordinary model rather than falling back to the emulated engine", async () => {
      global.fetch = vi.fn();

      await expect(
        turn(
          {
            id: "anthropic/claude-sonnet-4.5",
            provider: "anthropic",
            name: "Sonnet",
          } as ModelDefinition,
          "cursor"
        )
      ).rejects.toThrow(/chooses its own model on your own account/);

      // The load-bearing half: NEITHER engine ran. A resolved turn here is a
      // completed run that never touched Cursor — the emulated engine's only
      // outbound sign is the `/stream` POST, and the harness arm is stubbed.
      expect(global.fetch).not.toHaveBeenCalled();
      expect(runHarnessTurnMock).not.toHaveBeenCalled();
    });

    it("sends the SENTINEL to the harness — the rule refuses configurations, not Cursor", async () => {
      // The control that makes the refusal above meaningful. A rule that
      // refused every Cursor turn would also satisfy "no silent emulation", so
      // the dispatch has to be observed CHOOSING the harness for a correctly
      // configured host — not merely observed not throwing.
      global.fetch = vi.fn();
      runHarnessTurnMock.mockResolvedValue({
        messageHistory: [],
        aborted: false,
      });

      await turn(
        {
          id: "cursor/auto",
          provider: "cursor",
          name: "Cursor Auto",
        } as ModelDefinition,
        "cursor"
      );

      expect(runHarnessTurnMock).toHaveBeenCalledTimes(1);
      // …and the emulated engine, whose only outbound sign is the `/stream`
      // POST, was never reached.
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("leaves the BROKERED fallback alone — ineligible there still degrades", async () => {
      // The exemption is keyed on `modelAccess`, and the warn-and-emulate path
      // it does not touch is the one that keeps an eval batch running when a
      // case names a BYOK model.
      global.fetch = vi.fn().mockResolvedValue(
        createSseResponse([
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ])
      );

      const resolved = await turn(
        {
          id: "llama3",
          provider: "ollama",
          name: "Llama 3",
        } as ModelDefinition,
        "claude-code"
      );
      await lastExecution;

      expect(resolved.messages).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
