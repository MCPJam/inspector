import { describe, it, expect, vi } from "vitest";
import { buildLocalStepHandlers } from "../step-handlers";
import type { LocalEvalTurnAcc } from "../drive-local-eval-turn";

function makeAcc(): LocalEvalTurnAcc {
  return {
    conversationMessages: [],
    capturedSpans: [],
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolsCalledByPrompt: [],
    assistantMessageByPrompt: [],
    toolErrorsByPrompt: [],
    pinnedToolErrors: [],
    activePromptIndex: 0,
    activePromptInputMessages: [],
    activePartialResponseMessages: [],
    activeCompletedStepCount: 0,
    activeTraceCtx: null,
    iterationError: undefined,
    iterationErrorDetails: undefined,
    pinnedSetupFailure: false,
  };
}

function makeCtx(acc: LocalEvalTurnAcc, overrides: Record<string, unknown> = {}) {
  const browser = {
    setActivePromptIndex: vi.fn(),
    setActiveWidgetChecks: vi.fn(),
    dismissCarriedWidget: vi.fn(async () => {}),
  };
  return {
    acc,
    browser: browser as any,
    mcpClientManager: {} as any,
    selectedServers: [],
    // Server can't be resolved → pinned setup failure (no MCP/model call needed).
    resolvePinnedServerKey: () => undefined,
    prepared: null,
    llmModel: null,
    test: { model: "gpt-4-turbo", provider: "openai" },
    runStartedAt: 0,
    runIndex: 0,
    iterationId: "iter-1",
    suiteId: "suite-1",
    runId: null,
    testCaseId: "case-1",
    abortSignal: undefined,
    toolChoice: undefined,
    extractToolCalls: () => [],
    ...overrides,
  } as any;
}

describe("buildLocalStepHandlers — acc-bridge delta extraction", () => {
  it("onToolCall (pinned, server not connected) reports the setup-failure delta from the mutated acc", async () => {
    const acc = makeAcc();
    const handlers = buildLocalStepHandlers(makeCtx(acc));

    const outcome = await handlers.onToolCall({
      step: {
        id: "tc1",
        kind: "toolCall",
        serverName: "Asana",
        toolName: "search",
        arguments: { q: "x" },
      },
      stepIndex: 0,
      turnOrdinal: 0,
    });

    // Delta surfaced as a StepEngineOutcome…
    expect(outcome.iterationError).toMatch(/not connected/i);
    expect(outcome.setupFailure).toBe(true);
    // …the pinned user+assistant summary messages were the delta…
    expect(outcome.messages?.length).toBeGreaterThan(0);
    // …and the shared acc was actually mutated by the real driver.
    expect(acc.pinnedSetupFailure).toBe(true);
    expect(acc.iterationError).toMatch(/not connected/i);
  });

  it("threads the per-turn ordinal into the acc bucket index", async () => {
    const acc = makeAcc();
    // Pre-fill turn 0 so the turn-1 call lands in its own slot.
    acc.toolsCalledByPrompt[0] = [];
    const handlers = buildLocalStepHandlers(makeCtx(acc));

    await handlers.onToolCall({
      step: {
        id: "tc2",
        kind: "toolCall",
        serverName: "Asana",
        toolName: "search",
        arguments: {},
      },
      stepIndex: 2,
      turnOrdinal: 1,
    });

    // driveLocalEvalTurn pushed this turn's (empty, since not connected) call
    // slice at index 1 — the bridge reads it back by turnOrdinal.
    expect(acc.toolsCalledByPrompt).toHaveLength(2);
  });
});
