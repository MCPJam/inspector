import { describe, it, expect, vi } from "vitest";

// Mock the local driver so a follow-up "turn" can emit a synthetic error span
// into the acc — this exercises R2's span-derived `toolErrors` capture without a
// real model call.
const driveLocalEvalTurnMock = vi.fn();
vi.mock("../drive-local-eval-turn", () => ({
  driveLocalEvalTurn: (...args: unknown[]) => driveLocalEvalTurnMock(...args),
}));

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
  } as unknown as LocalEvalTurnAcc;
}

function makeCtx(acc: LocalEvalTurnAcc) {
  return {
    acc,
    browser: {} as never,
    mcpClientManager: {} as never,
    selectedServers: [],
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
  } as never;
}

describe("onFollowUp surfaces a follow-up turn's tool errors (R2 fix)", () => {
  it("captures an errored tool span from the follow-up turn into toolErrors", async () => {
    const acc = makeAcc();
    // The follow-up turn errors a tool (e.g. view-cart) — emit an error span.
    driveLocalEvalTurnMock.mockImplementation(async (params: any) => {
      params.acc.conversationMessages.push(
        { role: "user", content: params.promptTurn.prompt },
        { role: "assistant", content: "tried" },
      );
      params.acc.capturedSpans.push({
        id: "s1",
        category: "tool",
        status: "error",
        name: "view-cart",
        startMs: 0,
        endMs: 1,
        promptIndex: 0,
      });
    });

    const handlers = buildLocalStepHandlers(makeCtx(acc));
    const outcome = await handlers.onFollowUp!({
      text: "Show my cart",
      stepIndex: 1,
      turnOrdinal: 0,
    });

    // The follow-up turn's tool error now surfaces (the gap the old driveFollowUp had).
    expect(outcome.toolErrors).toEqual([
      { kind: "protocol-error", toolName: "view-cart" },
    ]);
    // …and the user message was the message delta.
    expect(outcome.messages?.length).toBe(2);
  });

  it("a clean follow-up turn reports no toolErrors", async () => {
    const acc = makeAcc();
    driveLocalEvalTurnMock.mockImplementation(async (params: any) => {
      params.acc.conversationMessages.push(
        { role: "user", content: params.promptTurn.prompt },
        { role: "assistant", content: "ok" },
      );
      // no error spans
    });

    const handlers = buildLocalStepHandlers(makeCtx(acc));
    const outcome = await handlers.onFollowUp!({
      text: "Show my cart",
      stepIndex: 1,
      turnOrdinal: 0,
    });

    expect(outcome.toolErrors).toBeUndefined();
  });
});
