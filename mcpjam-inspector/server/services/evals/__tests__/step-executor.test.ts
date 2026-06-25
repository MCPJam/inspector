import { describe, it, expect, vi } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  createStepExecutionState,
  executeSteps,
  hasWidgetDrivingStep,
  stepsVerdict,
  type StepEngineOutcome,
  type StepExecutorHandlers,
} from "../step-executor";
import type { BrowserSessionContext } from "../../browser-session-context";

type BrowserMock = Pick<
  BrowserSessionContext,
  | "replayInteractStep"
  | "evaluateWidgetAssertion"
  | "setKeepWidgetsMountedForSteps"
  | "setActivePromptIndex"
  | "setActiveAuthoredStepId"
  | "widgetRenderObservations"
  | "drainFollowUps"
>;

function makeBrowser(overrides: Partial<BrowserMock> = {}): BrowserMock {
  return {
    setActivePromptIndex: vi.fn(),
    setActiveAuthoredStepId: vi.fn(),
    setKeepWidgetsMountedForSteps: vi.fn(),
    replayInteractStep: vi.fn(async () => ({ ok: true })),
    evaluateWidgetAssertion: vi.fn(async () => ({ ok: true })),
    widgetRenderObservations: [],
    drainFollowUps: vi.fn(() => []),
    ...overrides,
  };
}

function makeHandlers(
  partial: Partial<StepExecutorHandlers> = {},
): StepExecutorHandlers {
  return {
    onPrompt: vi.fn(
      async (): Promise<StepEngineOutcome> => ({
        messages: [{ role: "assistant", content: "ok" }],
        toolCalls: [],
      }),
    ),
    onToolCall: vi.fn(
      async (): Promise<StepEngineOutcome> => ({
        messages: [{ role: "assistant", content: "tool ran" }],
        toolCalls: [{ toolName: "create_view", arguments: {} }],
      }),
    ),
    ...partial,
  };
}

describe("step-executor", () => {
  it("runs prompt + toolCall steps through the engine handlers and accumulates state", async () => {
    const steps: TestStep[] = [
      { id: "s1", kind: "prompt", prompt: "Draw a cat" },
      {
        id: "s2",
        kind: "toolCall",
        serverName: "viewer",
        toolName: "create_view",
        arguments: { animal: "cat" },
      },
    ];
    const state = createStepExecutionState();
    const handlers = makeHandlers();
    const result = await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers,
    });
    expect(result.iterationError).toBeUndefined();
    expect(handlers.onPrompt).toHaveBeenCalledTimes(1);
    expect(handlers.onToolCall).toHaveBeenCalledTimes(1);
    // Both engine steps produced transcript messages.
    expect(state.messages).toHaveLength(2);
    expect(state.toolCalls).toEqual([
      { toolName: "create_view", arguments: {} },
    ]);
  });

  it("passes verdict when a transcript-predicate assert passes against the state snapshot", async () => {
    const steps: TestStep[] = [
      {
        id: "s1",
        kind: "toolCall",
        serverName: "viewer",
        toolName: "create_view",
        arguments: {},
      },
      {
        id: "s2",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "create_view",
          args: { args: {} },
        },
      },
    ];
    const state = createStepExecutionState();
    await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers(),
    });
    expect(state.assertionResults).toHaveLength(1);
    expect(state.assertionResults[0]!.passed).toBe(true);
    expect(state.assertionResults[0]!.predicateResult).toBeDefined();
    expect(stepsVerdict(state).passed).toBe(true);
  });

  it("fails verdict when a transcript-predicate assert fails (no matching tool call)", async () => {
    const steps: TestStep[] = [
      { id: "s1", kind: "prompt", prompt: "hi" },
      {
        id: "s2",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "never_called",
          args: { args: {} },
        },
      },
    ];
    const state = createStepExecutionState();
    await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers({
        onPrompt: vi.fn(
          async (): Promise<StepEngineOutcome> => ({
            messages: [],
            toolCalls: [],
          }),
        ),
      }),
    });
    expect(state.assertionResults[0]!.passed).toBe(false);
    expect(stepsVerdict(state).passed).toBe(false);
  });

  it("interact step that fails closed (widget not mounted) records an interaction failure and fails the verdict", async () => {
    const steps: TestStep[] = [
      {
        id: "s1",
        kind: "interact",
        toolName: "create_view",
        action: {
          kind: "click",
          target: { testId: "submit" },
        },
      },
    ];
    const state = createStepExecutionState();
    const browser = makeBrowser({
      replayInteractStep: vi.fn(async () => ({
        ok: false,
        reason: 'no mounted widget for tool "create_view"',
      })),
    });
    await executeSteps({ steps, state, browser, handlers: makeHandlers() });
    expect(state.interactionFailures).toHaveLength(1);
    expect(state.interactionFailures[0]!.toolName).toBe("create_view");
    expect(stepsVerdict(state).passed).toBe(false);
  });

  it("folds widget→host tool calls from an interact step into the transcript so a later toolCalledWith assert passes", async () => {
    const steps: TestStep[] = [
      {
        id: "click",
        kind: "interact",
        toolName: "view-cart",
        action: { kind: "click", target: { role: { role: "button", name: "Proceed to checkout" } } },
      },
      {
        id: "assert",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "checkout",
          args: { args: {} },
        },
      },
    ];
    const state = createStepExecutionState();
    const browser = makeBrowser({
      // The click made the widget invoke the `checkout` host tool — surfaced on
      // the interact outcome, NOT through the model engine handlers.
      replayInteractStep: vi.fn(async () => ({
        ok: true,
        widgetToolCalls: [
          { name: "checkout", args: { cartId: "c1" }, ok: true, elapsedMs: 2 },
        ],
      })),
    });
    await executeSteps({ steps, state, browser, handlers: makeHandlers() });
    // The widget call landed in the unified transcript timeline...
    expect(state.toolCalls).toEqual([
      { toolName: "checkout", arguments: { cartId: "c1" } },
    ]);
    // ...so the single "tool was called" check passes even though no model
    // step ever called `checkout`.
    expect(state.assertionResults[0]!.passed).toBe(true);
    expect(stepsVerdict(state).passed).toBe(true);
  });

  it("widgetRendered assert sees the browser session's live render observations", async () => {
    // Regression: the executor must bind state.widgetRenderObservations to the
    // browser's live array. Without it, snapshotTranscript() evaluates the
    // `widgetRendered` predicate against an empty array and fails closed even
    // though the session recorded a `rendered` observation.
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "Show me a redbull" },
      {
        id: "a",
        kind: "assert",
        assertion: { type: "widgetRendered", toolName: "search-products" },
      },
    ];
    const state = createStepExecutionState();
    const browser = makeBrowser({
      // The live array a real session pushes into as widgets mount — already
      // populated (the prompt's tool render happened before this assert runs).
      widgetRenderObservations: [
        {
          toolCallId: "tc1",
          toolName: "search-products",
          serverId: "srv1",
          status: "rendered",
          elapsedMs: 120,
          ts: 1,
          promptIndex: 0,
        },
      ],
    });
    await executeSteps({ steps, state, browser, handlers: makeHandlers() });
    expect(state.assertionResults).toHaveLength(1);
    expect(state.assertionResults[0]!.passed).toBe(true);
    expect(stepsVerdict(state).passed).toBe(true);
  });

  it("stamps each step's authored id on the browser session, then clears to null", async () => {
    const steps: TestStep[] = [
      { id: "p1", kind: "prompt", prompt: "Show me a redbull" },
      {
        id: "i1",
        kind: "interact",
        toolName: "search-products",
        action: {
          kind: "click",
          target: { role: { role: "button", name: "Add to cart" } },
        },
      },
      {
        id: "a1",
        kind: "assert",
        assertion: { type: "widgetRendered", toolName: "search-products" },
      },
    ];
    const state = createStepExecutionState();
    const browser = makeBrowser({
      // Non-empty so the widgetRendered assert passes and the run reaches the end.
      widgetRenderObservations: [
        {
          toolCallId: "tc1",
          toolName: "search-products",
          serverId: "srv1",
          status: "rendered",
          elapsedMs: 10,
          ts: 1,
          promptIndex: 0,
        },
      ],
    });
    await executeSteps({ steps, state, browser, handlers: makeHandlers() });
    const calls = (browser.setActiveAuthoredStepId as ReturnType<typeof vi.fn>)
      .mock.calls;
    // One stamp per authored step, in order, then a trailing null on loop exit.
    expect(calls.map((c) => c[0])).toEqual(["p1", "i1", "a1", null]);
  });

  it("widget assertion evaluates against the live widget DOM (browser), not the predicate engine", async () => {
    const steps: TestStep[] = [
      {
        id: "s1",
        kind: "assert",
        assertion: {
          kind: "textVisible",
          toolName: "create_view",
          text: "Cat",
        },
      },
    ];
    const state = createStepExecutionState();
    const evaluateWidgetAssertion = vi.fn(async () => ({ ok: true }));
    const browser = makeBrowser({ evaluateWidgetAssertion });
    await executeSteps({ steps, state, browser, handlers: makeHandlers() });
    expect(evaluateWidgetAssertion).toHaveBeenCalledWith("create_view", {
      kind: "textVisible",
      toolName: "create_view",
      text: "Cat",
    });
    expect(state.assertionResults[0]!.passed).toBe(true);
    // No predicate engine result for a DOM assertion.
    expect(state.assertionResults[0]!.predicateResult).toBeUndefined();
  });

  it("transcript boundary: interact/assert steps never append to state.messages", async () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "go" },
      {
        id: "i",
        kind: "interact",
        toolName: "create_view",
        action: { kind: "wait", ms: 10 },
      },
      {
        id: "a",
        kind: "assert",
        assertion: { type: "widgetRendered" },
      },
    ];
    const state = createStepExecutionState();
    await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers({
        onPrompt: vi.fn(
          async (): Promise<StepEngineOutcome> => ({
            messages: [{ role: "assistant", content: "done" }],
          }),
        ),
      }),
    });
    // Only the prompt step produced a transcript message.
    expect(state.messages).toHaveLength(1);
  });

  it("arms keepWidgetsMountedForSteps only when an interact/widget-assert step exists", async () => {
    expect(
      hasWidgetDrivingStep([{ id: "p", kind: "prompt", prompt: "x" }]),
    ).toBe(false);
    expect(
      hasWidgetDrivingStep([
        {
          id: "i",
          kind: "interact",
          toolName: "t",
          action: { kind: "wait", ms: 1 },
        },
      ]),
    ).toBe(true);

    const browser = makeBrowser();
    await executeSteps({
      steps: [
        {
          id: "i",
          kind: "interact",
          toolName: "t",
          action: { kind: "wait", ms: 1 },
        },
      ],
      state: createStepExecutionState(),
      browser,
      handlers: makeHandlers(),
    });
    expect(browser.setKeepWidgetsMountedForSteps).toHaveBeenCalledWith(true);
  });

  it("stops on a fatal engine error and surfaces it (setup vs assertion failure)", async () => {
    const steps: TestStep[] = [
      {
        id: "s1",
        kind: "toolCall",
        serverName: "viewer",
        toolName: "create_view",
        arguments: {},
      },
      {
        id: "s2",
        kind: "assert",
        assertion: { type: "widgetRendered" },
      },
    ];
    const state = createStepExecutionState();
    const onToolCall = vi.fn(
      async (): Promise<StepEngineOutcome> => ({
        iterationError: "server not connected",
        setupFailure: true,
      }),
    );
    const result = await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers({ onToolCall }),
    });
    expect(result.iterationError).toBe("server not connected");
    expect(result.setupFailure).toBe(true);
    // The assert after the fatal error never ran.
    expect(state.assertionResults).toHaveLength(0);
  });

  // PR1b bucket contract: tool calls bucket by the `stepTurnIndices` turn
  // ordinal (prompt AND toolCall open turns; interact folds into the current
  // turn), so the verdict adapter can feed `evaluateMultiTurnResults` with zero
  // reconstruction. This is the `prompt → toolCall → interact` divergence case.
  it("buckets tool calls by turn: prompt(0), toolCall(1), interact widget call → current turn(1)", async () => {
    const steps: TestStep[] = [
      { id: "s1", kind: "prompt", prompt: "Search" },
      {
        id: "s2",
        kind: "toolCall",
        serverName: "viewer",
        toolName: "create_view",
        arguments: {},
      },
      {
        id: "s3",
        kind: "interact",
        toolName: "search-products",
        action: { kind: "click", target: { testId: "add" } },
      },
    ];
    const state = createStepExecutionState();
    const handlers = makeHandlers({
      onPrompt: vi.fn(
        async (): Promise<StepEngineOutcome> => ({
          messages: [{ role: "assistant", content: "ok" }],
          toolCalls: [{ toolName: "search", arguments: { q: "x" } }],
        }),
      ),
      // onToolCall default returns a `create_view` call.
    });
    const browser = makeBrowser({
      replayInteractStep: vi.fn(async () => ({
        ok: true,
        widgetToolCalls: [
          { name: "add-to-cart", args: { id: 1 }, ok: true, elapsedMs: 1 },
        ],
      })),
    });
    await executeSteps({ steps, state, browser, handlers });

    // Flat list preserves execution order across all sources.
    expect(state.toolCalls).toEqual([
      { toolName: "search", arguments: { q: "x" } },
      { toolName: "create_view", arguments: {} },
      { toolName: "add-to-cart", arguments: { id: 1 } },
    ]);
    // Bucketed by TURN: the prompt's call → turn 0; the pinned toolCall's call →
    // turn 1; the interact's widget→host call folds into the CURRENT turn (1),
    // NOT turn 0 — the divergence the unified `turnOrdinal` resolves.
    expect(state.toolCallsByTurn).toEqual([
      [{ toolName: "search", arguments: { q: "x" } }],
      [
        { toolName: "create_view", arguments: {} },
        { toolName: "add-to-cart", arguments: { id: 1 } },
      ],
    ]);
    // The ordinal advanced on the pinned toolCall (turn 1) — the former
    // prompt-only counter would have stamped it 0.
    expect(browser.setActivePromptIndex).toHaveBeenCalledWith(0);
    expect(browser.setActivePromptIndex).toHaveBeenCalledWith(1);
  });

  it("responseContains assert sees assistant text from state.messages at assert position", async () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "hi" },
      {
        id: "a",
        kind: "assert",
        assertion: { type: "responseContains", needle: "Done" },
      },
    ];
    const state = createStepExecutionState();
    await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers({
        onPrompt: vi.fn(
          async (): Promise<StepEngineOutcome> => ({
            messages: [{ role: "assistant", content: "Done" }],
            toolCalls: [],
          }),
        ),
      }),
    });
    expect(state.assertionResults).toHaveLength(1);
    expect(state.assertionResults[0]!.passed).toBe(true);
    expect(stepsVerdict(state).passed).toBe(true);
  });

  it("responseContains assert fails when assistant text does not match", async () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "hi" },
      {
        id: "a",
        kind: "assert",
        assertion: { type: "responseContains", needle: "WILL-NOT-MATCH" },
      },
    ];
    const state = createStepExecutionState();
    await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers({
        onPrompt: vi.fn(
          async (): Promise<StepEngineOutcome> => ({
            messages: [{ role: "assistant", content: "Done" }],
            toolCalls: [],
          }),
        ),
      }),
    });
    expect(state.assertionResults[0]!.passed).toBe(false);
    expect(stepsVerdict(state).passed).toBe(false);
  });

  // PR6 fail-fast: the first failed assert/interact halts the run; later steps
  // are recorded as Skipped (never evaluated), and the verdict is failed.
  it("fail-fast: a failed assert halts execution and Skips later steps", async () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "hi" },
      {
        id: "a1",
        kind: "assert",
        // No `never` tool was called → this assert FAILS.
        assertion: {
          type: "toolCalledWith",
          toolName: "never",
          args: { args: {} },
        },
      },
      {
        id: "a2",
        // Would PASS (assistant message "ok" is non-empty) — but never runs.
        kind: "assert",
        assertion: { type: "finalAssistantMessageNonEmpty" },
      },
    ];
    const state = createStepExecutionState();
    await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers(),
    });

    // Only the first (failing) assert ran.
    expect(state.assertionResults).toHaveLength(1);
    expect(state.assertionResults[0]!.passed).toBe(false);
    // The second assert was Skipped, not evaluated.
    expect(state.skippedSteps.map((s) => s.stepId)).toEqual(["a2"]);
    // Stopping only ever happens BECAUSE something failed → verdict is failed.
    expect(stepsVerdict(state).passed).toBe(false);
  });

  it("emits per-step status: running → ok/fail, then skipped for the halted tail", async () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "hi" },
      {
        id: "a1",
        kind: "assert",
        assertion: { type: "toolCalledWith", toolName: "never", args: { args: {} } },
      },
      {
        id: "a2",
        kind: "assert",
        assertion: { type: "finalAssistantMessageNonEmpty" },
      },
    ];
    const events: Array<{ stepId: string; status: string }> = [];
    await executeSteps({
      steps,
      state: createStepExecutionState(),
      browser: makeBrowser(),
      handlers: makeHandlers(),
      onStepStatus: (e) => events.push({ stepId: e.stepId, status: e.status }),
    });
    expect(events).toEqual([
      { stepId: "p", status: "running" },
      { stepId: "p", status: "ok" },
      { stepId: "a1", status: "running" },
      { stepId: "a1", status: "fail" },
      { stepId: "a2", status: "skipped" },
    ]);
  });

  it("drives a widget ui/message follow-up by default (no flag) and no-ops without an onFollowUp handler", async () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "Show me a redbull" },
      {
        id: "i",
        kind: "interact",
        toolName: "search-products",
        action: { kind: "click", target: { text: "🛒" } },
      },
    ];
    // With an onFollowUp handler, a drained follow-up is driven (always-on now).
    const onFollowUp = vi.fn(async () => ({ toolCalls: [] }));
    const browserA = makeBrowser({
      drainFollowUps: vi
        .fn<() => string[]>()
        .mockReturnValueOnce(["Show my cart"])
        .mockReturnValue([]),
    });
    await executeSteps({
      steps,
      state: createStepExecutionState(),
      browser: browserA,
      handlers: makeHandlers({ onFollowUp }),
    });
    expect(onFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Show my cart", turnOrdinal: 0 }),
    );

    // Without an onFollowUp handler, the executor no-ops (legacy handlers safe).
    const browserB = makeBrowser({
      drainFollowUps: vi.fn(() => ["Show my cart"]),
    });
    const result = await executeSteps({
      steps,
      state: createStepExecutionState(),
      browser: browserB,
      handlers: makeHandlers(), // no onFollowUp
    });
    expect(result.iterationError).toBeUndefined();
    expect(browserB.drainFollowUps).not.toHaveBeenCalled();
  });
});
