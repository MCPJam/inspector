import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock both engine adapters; the facade is pure dispatch + result normalization.
const runAssistantTurnMock = vi.fn();
const runDirectChatTurnMock = vi.fn();
const consumeDirectChatTurnHeadlessMock = vi.fn();
const consumeDirectChatTurnFullStreamMock = vi.fn();

vi.mock("../assistant-turn", () => ({
  runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
}));
vi.mock("../direct-chat-turn", () => ({
  runDirectChatTurn: (...args: unknown[]) => runDirectChatTurnMock(...args),
  consumeDirectChatTurnHeadless: (...args: unknown[]) =>
    consumeDirectChatTurnHeadlessMock(...args),
  // The facade stamps the direct engine's response messages with mcp-tool-origin
  // metadata (parity with the hosted engine). Identity here — these tests use
  // tool-less messages where stamping is a no-op — so the assertions still see
  // the raw response slice.
  stampMcpToolOriginProviderOptions: (messages: unknown[]) => messages,
}));
vi.mock("../direct-chat-turn-full-stream", () => ({
  consumeDirectChatTurnFullStream: (...args: unknown[]) =>
    consumeDirectChatTurnFullStreamMock(...args),
}));

// eslint-disable-next-line import/first
import { runUnifiedAssistantTurn } from "../turn-execution";

beforeEach(() => {
  vi.clearAllMocks();
});

const userMsg = { role: "user", content: "hi" } as const;
const asstMsg = { role: "assistant", content: "yo" } as const;

describe("runUnifiedAssistantTurn", () => {
  it("hosted: delegates to runAssistantTurn with the runtime's endpoint and slices newMessages", async () => {
    runAssistantTurnMock.mockResolvedValue({
      messages: [userMsg, asstMsg],
      assistantMessages: [asstMsg],
      toolCalls: [],
      toolResults: [],
      turnTrace: { spans: [] },
      usage: { totalTokens: 3 },
      finishReason: "stop",
    });

    const res = await runUnifiedAssistantTurn({
      runtime: {
        kind: "hosted",
        endpointPath: "/stream/org",
        extraBodyFields: { providerKey: "k" },
      },
      streamSink: "none",
      messages: [userMsg],
    } as never);

    expect(runAssistantTurnMock).toHaveBeenCalledTimes(1);
    const passed = runAssistantTurnMock.mock.calls[0][0];
    expect(passed.endpointPath).toBe("/stream/org");
    expect(passed.extraBodyFields).toEqual({ providerKey: "k" });
    // routing is lifted out of `runtime` into the engine options, not nested.
    expect(passed.runtime).toBeUndefined();
    // newMessages = full transcript minus the input history (headless sink).
    expect(res.newMessages).toEqual([asstMsg]);
    expect(res.messages).toEqual([userMsg, asstMsg]);
    expect(res.aborted).toBe(false);
  });

  it("hosted: hands the runtime's harness selection to the turn, typed", async () => {
    runAssistantTurnMock.mockResolvedValue({
      messages: [userMsg, asstMsg],
      assistantMessages: [asstMsg],
      toolCalls: [],
      toolResults: [],
      turnTrace: { spans: [] },
      usage: { totalTokens: 3 },
      finishReason: "stop",
    });
    const selection = {
      source: "org",
      modelId: "anthropic/claude-sonnet-4.5",
      connectionRef: { kind: "orgProvider", id: "orgprov_1" },
      fallback: { provider: "none", model: "none" },
    };
    await runUnifiedAssistantTurn({
      runtime: {
        kind: "hosted",
        endpointPath: "/stream/org",
        harness: "claude-code",
        modelSelection: selection,
      },
      streamSink: "none",
      messages: [userMsg],
    } as never);
    expect(runAssistantTurnMock.mock.calls[0][0]).toMatchObject({
      harness: "claude-code",
      modelSelection: selection,
    });
  });

  it("hosted + ui: does NOT eagerly slice newMessages (transcript drains async)", async () => {
    // ui returns before the stream drains, so result.messages is not rolled
    // forward yet — newMessages must not be a stale slice.
    runAssistantTurnMock.mockResolvedValue({
      messages: [userMsg],
      assistantMessages: [],
      toolCalls: [],
      toolResults: [],
      turnTrace: { spans: [] },
      usage: {},
      finishReason: undefined,
      response: new Response("x"),
    });
    const res = await runUnifiedAssistantTurn({
      runtime: { kind: "hosted", endpointPath: "/stream" },
      streamSink: "ui",
      messages: [userMsg],
    } as never);
    expect(res.newMessages).toEqual([]);
    expect(res.toolCalls).toEqual([]);
  });

  it("direct + none: delegates to runDirectChatTurn, returns the real turnTrace and a unified result", async () => {
    runDirectChatTurnMock.mockReturnValue({ handle: true });
    consumeDirectChatTurnHeadlessMock.mockResolvedValue({
      messages: [asstMsg],
      steps: [],
      totalUsage: { totalTokens: 5 },
      finishReason: "stop",
      spans: [],
      turnTrace: { spans: [{ id: "s1" }], usage: { totalTokens: 5 } },
      aborted: false,
    });

    const res = await runUnifiedAssistantTurn({
      runtime: { kind: "direct", llmModel: {}, modelId: "m1", provider: "p" },
      streamSink: "none",
      messages: [userMsg],
      systemPrompt: "sys",
      tools: {},
    } as never);

    expect(runDirectChatTurnMock).toHaveBeenCalledTimes(1);
    const passed = runDirectChatTurnMock.mock.calls[0][0];
    expect(passed.modelId).toBe("m1");
    expect(passed.messageHistory).toEqual([userMsg]);
    // newMessages = this turn's response; messages = input ++ response.
    expect(res.newMessages).toEqual([asstMsg]);
    expect(res.messages).toEqual([userMsg, asstMsg]);
    // real turnTrace surfaced from the engine, not reconstructed loosely.
    expect(res.turnTrace).toEqual({
      spans: [{ id: "s1" }],
      usage: { totalTokens: 5 },
    });
    expect(res.usage).toEqual({ totalTokens: 5 });
    expect(res.aborted).toBe(false);
    expect(runAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("direct: surfaces headless.aborted so callers can drop cancelled turns", async () => {
    runDirectChatTurnMock.mockReturnValue({ handle: true });
    consumeDirectChatTurnHeadlessMock.mockResolvedValue({
      messages: [],
      steps: [],
      totalUsage: {},
      finishReason: "stop",
      spans: [],
      turnTrace: { spans: [], usage: {} },
      aborted: true,
    });
    const res = await runUnifiedAssistantTurn({
      runtime: { kind: "direct", llmModel: {}, modelId: "m1" },
      streamSink: "none",
      messages: [userMsg],
      systemPrompt: "sys",
      tools: {},
    } as never);
    expect(res.aborted).toBe(true);
  });

  it("direct + ui: throws (wired in the chat-migration PR), not silently mis-routed", async () => {
    await expect(
      runUnifiedAssistantTurn({
        runtime: { kind: "direct", llmModel: {}, modelId: "m1" },
        streamSink: "ui",
        messages: [userMsg],
        systemPrompt: "sys",
        tools: {},
      } as never),
    ).rejects.toThrow(/streamSink 'ui'/);
  });

  it("direct: forwards the normalized onLiveTextDelta callback to the engine", async () => {
    runDirectChatTurnMock.mockReturnValue({ handle: true });
    consumeDirectChatTurnHeadlessMock.mockResolvedValue({
      messages: [],
      steps: [],
      totalUsage: {},
      finishReason: "stop",
      spans: [],
      turnTrace: { spans: [], usage: {} },
      aborted: false,
    });
    const onLiveTextDelta = vi.fn();

    await runUnifiedAssistantTurn({
      runtime: { kind: "direct", llmModel: {}, modelId: "m1" },
      streamSink: "none",
      messages: [userMsg],
      systemPrompt: "sys",
      tools: {},
      onLiveTextDelta,
    } as never);

    expect(runDirectChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ onLiveTextDelta }),
    );
  });

  it("direct: forwards onEngineError so engine failures aren't lost (chat persistence gate)", async () => {
    runDirectChatTurnMock.mockReturnValue({ handle: true });
    consumeDirectChatTurnHeadlessMock.mockResolvedValue({
      messages: [],
      steps: [],
      totalUsage: {},
      finishReason: "error",
      spans: [],
      turnTrace: { spans: [], usage: {} },
      aborted: false,
    });
    const onEngineError = vi.fn();

    await runUnifiedAssistantTurn({
      runtime: { kind: "direct", llmModel: {}, modelId: "m1" },
      streamSink: "none",
      messages: [userMsg],
      systemPrompt: "sys",
      tools: {},
      onEngineError,
    } as never);

    expect(runDirectChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ onEngineError }),
    );
  });

  it("direct: maps onToolResultChunk into the engine's traceEvents (browser render hook)", async () => {
    runDirectChatTurnMock.mockReturnValue({ handle: true });
    consumeDirectChatTurnHeadlessMock.mockResolvedValue({
      messages: [],
      steps: [],
      totalUsage: {},
      finishReason: "stop",
      spans: [],
      turnTrace: { spans: [], usage: {} },
      aborted: false,
    });
    const onToolResultChunk = vi.fn();

    await runUnifiedAssistantTurn({
      runtime: { kind: "direct", llmModel: {}, modelId: "m1" },
      streamSink: "none",
      messages: [userMsg],
      systemPrompt: "sys",
      tools: {},
      onToolResultChunk,
    } as never);

    const passed = runDirectChatTurnMock.mock.calls[0][0];
    expect(passed.traceEvents).toEqual({ onToolResultChunk });
  });

  it("direct: onToolResultChunk is inert for callers that don't set it (no traceEvents)", async () => {
    runDirectChatTurnMock.mockReturnValue({ handle: true });
    consumeDirectChatTurnHeadlessMock.mockResolvedValue({
      messages: [asstMsg],
      steps: [],
      totalUsage: {},
      finishReason: "stop",
      spans: [],
      turnTrace: { spans: [], usage: {} },
      aborted: false,
    });

    const res = await runUnifiedAssistantTurn({
      runtime: { kind: "direct", llmModel: {}, modelId: "m1" },
      streamSink: "none",
      messages: [userMsg],
      systemPrompt: "sys",
      tools: {},
    } as never);

    const passed = runDirectChatTurnMock.mock.calls[0][0];
    // No hook → no traceEvents object and no retry budget forwarded at all.
    expect(passed.traceEvents).toBeUndefined();
    expect("maxRetries" in passed).toBe(false);
    // …and the existing result contract and consumer are unchanged.
    expect(res.messages).toEqual([userMsg, asstMsg]);
    expect(res.newMessages).toEqual([asstMsg]);
    expect(res).not.toHaveProperty("direct");
    expect(consumeDirectChatTurnFullStreamMock).not.toHaveBeenCalled();
  });

  describe("direct: the eval runner's contract", () => {
    const headlessResult = (messages: unknown[] = []) => ({
      messages,
      steps: [],
      totalUsage: {},
      finishReason: "stop",
      spans: [],
      turnTrace: { spans: [], usage: {} },
      aborted: false,
    });
    const runDirect = (extra: Record<string, unknown> = {}) =>
      runUnifiedAssistantTurn({
        runtime: { kind: "direct", llmModel: {}, modelId: "m1" },
        streamSink: "none",
        messages: [userMsg],
        systemPrompt: "sys",
        tools: {},
        ...extra,
      } as never);

    it("forwards maxRetries and maps the step hooks into traceEvents", async () => {
      runDirectChatTurnMock.mockReturnValue({ handle: true });
      consumeDirectChatTurnHeadlessMock.mockResolvedValue(headlessResult());
      const onRequestPayload = vi.fn();
      const onStepSnapshot = vi.fn();

      await runDirect({ maxRetries: 3, onRequestPayload, onStepSnapshot });

      const passed = runDirectChatTurnMock.mock.calls[0][0];
      expect(passed.maxRetries).toBe(3);
      expect(passed.traceEvents).toEqual({ onRequestPayload, onStepSnapshot });
    });

    it("hands the live trace context over before the stream is consumed", async () => {
      const traceContext = { recordedSpans: [] };
      runDirectChatTurnMock.mockReturnValue({ traceContext });
      const order: string[] = [];
      consumeDirectChatTurnHeadlessMock.mockImplementation(async () => {
        order.push("consume");
        return headlessResult();
      });
      const onTraceContext = vi.fn(() => order.push("traceContext"));

      await runDirect({ onTraceContext });

      expect(onTraceContext).toHaveBeenCalledWith(traceContext);
      expect(order).toEqual(["traceContext", "consume"]);
    });

    it("consumes part by part under onStreamPart and returns the raw step data", async () => {
      const handle = { handle: true };
      runDirectChatTurnMock.mockReturnValue(handle);
      consumeDirectChatTurnFullStreamMock.mockResolvedValue({
        ...headlessResult([asstMsg]),
        steps: [{ stepNumber: 0 }],
        totalUsage: { totalTokens: 9 },
        upstreamModel: "m1-2026-01-01",
      });
      const onStreamPart = vi.fn();

      const res = await runDirect({ onStreamPart });

      expect(consumeDirectChatTurnFullStreamMock).toHaveBeenCalledWith(
        handle,
        onStreamPart,
      );
      expect(consumeDirectChatTurnHeadlessMock).not.toHaveBeenCalled();
      expect(res.direct).toEqual({
        steps: [{ stepNumber: 0 }],
        totalUsage: { totalTokens: 9 },
        upstreamModel: "m1-2026-01-01",
      });
      expect(res.newMessages).toEqual([asstMsg]);
      expect(res.messages).toEqual([userMsg, asstMsg]);
    });
  });
});
