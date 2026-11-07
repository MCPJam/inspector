import { beforeEach, describe, expect, it, vi } from "vitest";

// Only `streamText` is replaced: the driver, the unified turn and the direct
// engine run for real, so these see what reaches the model and what is kept.
const streamTextMock = vi.fn();
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

import { driveLocalEvalTurn } from "../drive-local-eval-turn";
import type { DriveLocalEvalTurnParams } from "../drive-local-eval-turn";

const ids = { toolCallId: "call-1", toolName: "search" };
const toolCall = { type: "tool-call", ...ids, input: { q: "status" } };
const output = { type: "text", value: "ok" };
const toolResult = { type: "tool-result", ...ids, output };
const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
const responseMessages = [
  { role: "assistant", content: [toolCall] },
  { role: "tool", content: [toolResult] },
  { role: "assistant", content: "Found it." },
];

function stream(parts: unknown[], failWith?: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
      if (failWith !== undefined) throw failWith;
    },
  };
}

function streamResult(fullStream = stream([])) {
  return {
    fullStream,
    consumeStream: async () => {},
    response: Promise.resolve({ modelId: "gpt-x-2026-01-01" }),
    responseMessages: Promise.resolve(responseMessages),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve(usage),
    finishReason: Promise.resolve("stop"),
  };
}

function params(
  overrides: Partial<DriveLocalEvalTurnParams> = {},
  modelContext?: unknown,
): DriveLocalEvalTurnParams {
  const browser = {
    setActivePromptIndex: vi.fn(),
    setActiveWidgetChecks: vi.fn(),
    dismissCarriedWidget: vi.fn(async () => {}),
    getModelContext: () => modelContext,
    computerWidgetTools: {},
    browserInteractionSteps: [],
    handleDirectToolResultChunk: vi.fn(async () => {}),
  };
  return {
    promptIndex: 0,
    promptTurn: { prompt: "hello" } as never,
    acc: {
      conversationMessages: [],
      capturedSpans: [],
      accumulatedUsage: {},
      toolsCalledByPrompt: [],
      assistantMessageByPrompt: [],
      toolErrorsByPrompt: [],
      pinnedToolErrors: [],
      activePromptIndex: -1,
      activePromptInputMessages: [],
      activePartialResponseMessages: [],
      activeCompletedStepCount: 0,
      activeTraceCtx: null,
      iterationError: undefined,
      iterationErrorDetails: undefined,
      stepErrorSource: undefined,
      pinnedSetupFailure: false,
    },
    browser: browser as never,
    mcpClientManager: {} as never,
    selectedServers: [],
    resolvePinnedServerKey: () => undefined,
    prepared: {
      allTools: { search: { _serverId: "srv-1", inputSchema: {} } },
      enhancedSystemPrompt: "sys",
    } as never,
    llmModel: { provider: "openai.responses", modelId: "gpt-x" } as never,
    test: { model: "gpt-x", provider: "openai" },
    runStartedAt: Date.now(),
    runIndex: 0,
    iterationId: undefined,
    suiteId: undefined,
    runId: null,
    testCaseId: undefined,
    abortSignal: undefined,
    turnTimeoutMs: 60_000,
    turnRetries: 2,
    toolChoice: undefined,
    extractToolCalls: () => [],
    ...overrides,
  };
}

describe("driveLocalEvalTurn through the unified turn", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  it("hands the run's turnRetries to the model call and reports the provider's model", async () => {
    streamTextMock.mockReturnValueOnce(streamResult());
    const onModelCallSettled = vi.fn();

    const outcome = await driveLocalEvalTurn(
      params({ turnRetries: 4, onModelCallSettled }),
    );

    expect(outcome).toEqual({ kind: "completed" });
    expect(streamTextMock.mock.calls[0][0].maxRetries).toBe(4);
    expect(onModelCallSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "ok",
        upstreamModel: "gpt-x-2026-01-01",
        usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2 }),
      }),
    );
  });

  it("records the prompt without plugin context and stamps each tool part with its server", async () => {
    streamTextMock.mockReturnValueOnce(streamResult());
    const turnParams = params(
      {},
      { role: "user", content: [{ type: "text", text: "widget state" }] },
    );

    await driveLocalEvalTurn(turnParams);

    // The model saw the app's context on this turn's prompt…
    expect(streamTextMock.mock.calls[0][0].messages.at(-1).content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "widget state" },
    ]);
    // …the persisted transcript does not, and its tool parts name their
    // server the way hosted eval transcripts already do.
    const [prompt, call, result] = turnParams.acc
      .conversationMessages as Array<{
      content: unknown;
    }>;
    expect(prompt).toEqual({ role: "user", content: "hello" });
    expect(call.content).toEqual([
      { ...toolCall, providerOptions: { mcpjam: { serverId: "srv-1" } } },
    ]);
    expect(result.content).toEqual([
      { ...toolResult, providerOptions: { mcpjam: { serverId: "srv-1" } } },
    ]);
  });

  it("rethrows what the stream threw and leaves the runner this turn's trace", async () => {
    const providerError = new Error("429 Too Many Requests");
    const thrown = new Error("No output generated.");
    streamTextMock.mockReturnValueOnce(
      streamResult(stream([{ type: "error", error: providerError }], thrown)),
    );
    const onModelCallSettled = vi.fn();
    const turnParams = params({ onModelCallSettled });

    await expect(driveLocalEvalTurn(turnParams)).rejects.toBe(thrown);

    expect(onModelCallSettled).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", code: "provider_error" }),
    );
    // The runner's catch path finalizes these spans after the throw.
    expect(turnParams.acc.activeTraceCtx).not.toBeNull();
  });
});
