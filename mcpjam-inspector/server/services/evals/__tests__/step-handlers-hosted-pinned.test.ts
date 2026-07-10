// Hosted pinned (`toolCall`) step handling: buildHostedStepHandlers executes
// the pinned turn inspector-side (model-free) and injects a plain-text
// user+assistant pair into the hosted acc's messageHistory. The backend driver
// is mocked — a pinned turn must never reach it; the follow-up test asserts
// the executor drains widget `ui/message` follow-ups into it afterwards.
import { describe, it, expect, vi } from "vitest";
import { buildHostedStepHandlers } from "../step-handlers";
import {
  createStepExecutionState,
  executeSteps,
} from "../step-executor";
import { driveHostedEvalTurn } from "../drive-hosted-eval-turn";

vi.mock("../drive-hosted-eval-turn", () => ({
  driveHostedEvalTurn: vi.fn(async () => ({ kind: "completed" })),
  MAX_WIDGET_FOLLOWUP_TURNS: 3,
}));

const PINNED_STEP = {
  id: "tc1",
  kind: "toolCall",
  serverName: "Weather",
  toolName: "show_map",
  arguments: { city: "SF" },
} as any;

function makeAcc() {
  return {
    messageHistory: [] as any[],
    capturedSpans: [] as any[],
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolsCalledByPrompt: [] as any[][],
  };
}

function makeBrowser() {
  return {
    setActivePromptIndex: vi.fn(),
    setActiveAuthoredStepId: vi.fn(),
    setActiveWidgetChecks: vi.fn(),
    setKeepWidgetsMountedForSteps: vi.fn(),
    dismissCarriedWidget: vi.fn(async () => {}),
    renderPinnedToolResult: vi.fn(async () => {}),
    replayInteractStep: vi.fn(),
    evaluateWidgetAssertion: vi.fn(),
    drainFollowUps: vi.fn(() => [] as string[]),
    widgetRenderObservations: [] as any[],
  };
}

function makeCtx(
  acc: ReturnType<typeof makeAcc>,
  browser: ReturnType<typeof makeBrowser>,
  overrides: Record<string, unknown> = {},
) {
  return {
    acc,
    browser: browser as any,
    mcpClientManager: {
      executeTool: vi.fn(async () => ({ content: [], isError: false })),
    } as any,
    selectedServers: ["srv-1"],
    resolvePinnedServerKey: () => "srv-1",
    pinnedToolErrors: [],
    prepared: { allTools: {} } as any,
    modelDefinition: { id: "claude-haiku-4.5", provider: "anthropic" } as any,
    modelId: "anthropic/claude-haiku-4.5",
    evalAuthContext: { kind: "user_bearer", token: "Bearer t" } as any,
    endpointPath: "/stream",
    extraBodyFields: undefined,
    toolChoice: undefined,
    abortSignal: undefined,
    maxSteps: 8,
    runStartedAt: 0,
    isAborted: () => false,
    extractToolCalls: () => [],
    ...overrides,
  } as any;
}

describe("buildHostedStepHandlers — pinned toolCall", () => {
  it("executes the pinned tool, appends the text pair, and never touches the backend", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    // Pre-existing bucket at the same ordinal (e.g. a widget call) — the
    // handler must get-or-create-and-push, not clobber (the sparse-array trap).
    acc.toolsCalledByPrompt[1] = [{ toolName: "widget_click", arguments: {} }];
    const ctx = makeCtx(acc, browser);
    const handlers = buildHostedStepHandlers(ctx);

    const outcome = await handlers.onToolCall({
      step: PINNED_STEP,
      stepIndex: 2,
      turnOrdinal: 1,
    });

    expect(ctx.mcpClientManager.executeTool).toHaveBeenCalledWith(
      "srv-1",
      "show_map",
      { city: "SF" },
    );
    expect(vi.mocked(driveHostedEvalTurn)).not.toHaveBeenCalled();
    // Plain-text user+assistant pair injected for the next /stream turn.
    expect(acc.messageHistory).toEqual([
      { role: "user", content: 'Pinned tool call: show_map on "Weather"' },
      { role: "assistant", content: "Pinned tool call show_map executed" },
    ]);
    expect(acc.toolsCalledByPrompt[1]).toEqual([
      { toolName: "widget_click", arguments: {} },
      { toolName: "show_map", arguments: { city: "SF" } },
    ]);
    expect(browser.renderPinnedToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: expect.stringMatching(/^pinned-1-/),
        toolName: "show_map",
        serverId: "srv-1",
      }),
    );
    expect(browser.dismissCarriedWidget).toHaveBeenCalledOnce();
    expect(browser.setActiveWidgetChecks).toHaveBeenCalledWith([]);
    expect(outcome.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(outcome.iterationError).toBeUndefined();
    expect(outcome.toolCalls).toEqual([
      { toolName: "show_map", arguments: { city: "SF" } },
    ]);
  });

  it("records a content-error into the iteration-level sink without failing the run", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    const ctx = makeCtx(acc, browser, {
      mcpClientManager: {
        executeTool: vi.fn(async () => ({
          isError: true,
          content: [{ type: "text", text: "boom" }],
        })),
      },
    });
    const handlers = buildHostedStepHandlers(ctx);

    const outcome = await handlers.onToolCall({
      step: PINNED_STEP,
      stepIndex: 0,
      turnOrdinal: 0,
    });

    expect(outcome.toolErrors).toEqual([
      { toolName: "show_map", kind: "content-error", message: "boom" },
    ]);
    expect(ctx.pinnedToolErrors).toEqual(outcome.toolErrors);
    // A tool error is a graded failure, not a fatal one — the run continues.
    expect(outcome.iterationError).toBeUndefined();
    expect(outcome.setupFailure).toBeUndefined();
    expect(browser.renderPinnedToolResult).not.toHaveBeenCalled();
  });

  it("maps a not-connected server to iterationError + setupFailure with no phantom call", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    const ctx = makeCtx(acc, browser, {
      resolvePinnedServerKey: () => undefined,
    });
    const handlers = buildHostedStepHandlers(ctx);

    const outcome = await handlers.onToolCall({
      step: PINNED_STEP,
      stepIndex: 0,
      turnOrdinal: 0,
    });

    expect(outcome.iterationError).toMatch(/not connected/i);
    expect(outcome.setupFailure).toBe(true);
    expect(outcome.toolCalls).toBeUndefined();
    // Transcript honesty: the pair is still appended on failure.
    expect(acc.messageHistory).toHaveLength(2);
  });

  it("emits the pinned SSE payload when streaming", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    const emitPinnedTurn = vi.fn();
    const ctx = makeCtx(acc, browser, { emitPinnedTurn });
    const handlers = buildHostedStepHandlers(ctx);

    await handlers.onToolCall({
      step: PINNED_STEP,
      stepIndex: 1,
      turnOrdinal: 2,
    });

    expect(emitPinnedTurn).toHaveBeenCalledOnce();
    expect(emitPinnedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnIndex: 2,
        prompt: 'Pinned tool call: show_map on "Weather"',
        messages: acc.messageHistory,
        toolCall: { toolName: "show_map", arguments: { city: "SF" } },
        toolCallId: expect.stringMatching(/^pinned-2-/),
      }),
    );
  });

  // Nothing wraps executeSteps on the hosted path (local has a broad
  // iteration catch) — a throw from dismiss/render must be mapped to a failed
  // outcome, not escape persistence.
  it("maps a dismissCarriedWidget throw to a failed outcome instead of escaping", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    browser.dismissCarriedWidget.mockRejectedValue(
      new Error("host page crashed"),
    );
    const handlers = buildHostedStepHandlers(makeCtx(acc, browser));

    const outcome = await handlers.onToolCall({
      step: PINNED_STEP,
      stepIndex: 0,
      turnOrdinal: 0,
    });

    expect(outcome.iterationError).toContain("host page crashed");
    expect(outcome.setupFailure).toBeUndefined();
  });

  it("maps a renderPinnedToolResult throw to a failed outcome instead of escaping", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    browser.renderPinnedToolResult.mockRejectedValue(
      new Error("render timed out hard"),
    );
    const handlers = buildHostedStepHandlers(makeCtx(acc, browser));

    const outcome = await handlers.onToolCall({
      step: PINNED_STEP,
      stepIndex: 0,
      turnOrdinal: 0,
    });

    expect(outcome.iterationError).toContain("render timed out hard");
    expect(outcome.setupFailure).toBeUndefined();
  });
});

describe("executeSteps + hosted handlers — widget follow-ups after a pinned step", () => {
  it("drains ui/message follow-ups from the pinned widget into the hosted model driver", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    browser.drainFollowUps
      .mockReturnValueOnce(["hi from widget"])
      .mockReturnValue([]);
    const handlers = buildHostedStepHandlers(makeCtx(acc, browser));
    vi.mocked(driveHostedEvalTurn).mockClear();

    const result = await executeSteps({
      steps: [PINNED_STEP],
      state: createStepExecutionState(),
      browser: browser as any,
      handlers,
    });

    expect(result.iterationError).toBeUndefined();
    expect(vi.mocked(driveHostedEvalTurn)).toHaveBeenCalledOnce();
    expect(vi.mocked(driveHostedEvalTurn)).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "hi from widget", promptIndex: 0 }),
    );
  });

  it("bounds follow-up drains to MAX_WIDGET_FOLLOWUP_TURNS", async () => {
    const acc = makeAcc();
    const browser = makeBrowser();
    browser.drainFollowUps
      .mockReturnValueOnce(["a", "b", "c", "d"])
      .mockReturnValue([]);
    const handlers = buildHostedStepHandlers(makeCtx(acc, browser));
    vi.mocked(driveHostedEvalTurn).mockClear();

    await executeSteps({
      steps: [PINNED_STEP],
      state: createStepExecutionState(),
      browser: browser as any,
      handlers,
    });

    expect(vi.mocked(driveHostedEvalTurn)).toHaveBeenCalledTimes(3);
  });
});
