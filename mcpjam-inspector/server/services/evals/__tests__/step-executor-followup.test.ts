import { describe, it, expect, vi } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  createStepExecutionState,
  executeSteps,
  type StepEngineOutcome,
  type StepExecutorHandlers,
} from "../step-executor";
import { MAX_WIDGET_FOLLOWUP_TURNS } from "../drive-hosted-eval-turn";
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

const SEARCH_AND_CLICK: TestStep[] = [
  { id: "p", kind: "prompt", prompt: "Show me a redbull" },
  {
    id: "i",
    kind: "interact",
    toolName: "search-products",
    action: { kind: "click", target: { text: "🛒" } },
  },
];

describe("step-executor widget ui/message follow-up (PR3)", () => {
  it("drives a drained follow-up as a turn whose tool calls bucket into the interact's turn", async () => {
    // Drain order (R3 drains after EVERY step): prompt step → [], interact step
    // → ["Show my cart"] → []. So the cart click is what drives view-cart.
    const drainFollowUps = vi
      .fn<() => string[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["Show my cart"])
      .mockReturnValue([]);
    const onFollowUp = vi.fn(
      async (): Promise<StepEngineOutcome> => ({
        messages: [
          { role: "user", content: "Show my cart" },
          { role: "assistant", content: "Here's your cart." },
        ],
        toolCalls: [{ toolName: "view-cart", arguments: {} }],
      }),
    );
    const handlers: StepExecutorHandlers = {
      onPrompt: vi.fn(
        async (): Promise<StepEngineOutcome> => ({
          messages: [{ role: "assistant", content: "found it" }],
          toolCalls: [{ toolName: "search-products", arguments: {} }],
        }),
      ),
      onToolCall: vi.fn(),
      onFollowUp,
    };
    const state = createStepExecutionState();
    await executeSteps({
      steps: SEARCH_AND_CLICK,
      state,
      browser: makeBrowser({ drainFollowUps }),
      handlers,
    });

    // Follow-up driven exactly once, seeded by the drained text, sharing the
    // interact's turn ordinal (turn 0 — only one prompt step).
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Show my cart", turnOrdinal: 0 }),
    );
    // view-cart landed in turn 0's bucket (where a turn-0-scoped assert reads it),
    // alongside the prompt turn's search-products.
    expect(state.toolCallsByTurn[0]?.map((c) => c.toolName)).toEqual([
      "search-products",
      "view-cart",
    ]);
    expect(state.toolCalls.map((c) => c.toolName)).toContain("view-cart");
  });

  it("does nothing when the click drained no follow-up (e.g. a missed locator)", async () => {
    const onFollowUp = vi.fn();
    const handlers: StepExecutorHandlers = {
      onPrompt: vi.fn(async (): Promise<StepEngineOutcome> => ({})),
      onToolCall: vi.fn(),
      onFollowUp,
    };
    const browser = makeBrowser({ drainFollowUps: vi.fn(() => []) });
    await executeSteps({
      steps: SEARCH_AND_CLICK,
      state: createStepExecutionState(),
      browser,
      handlers,
    });
    expect(browser.drainFollowUps).toHaveBeenCalled(); // we DID check (observability)
    expect(onFollowUp).not.toHaveBeenCalled(); // ...but there was nothing to drive
  });

  it("drives a follow-up emitted during a PROMPT turn (R3: drain after prompt steps)", async () => {
    // A single prompt step whose rendered widget auto-sends a ui/message — no
    // interact step involved. Pre-R3 (hosted recursion only) the LOCAL path
    // dropped this; now the executor drains it.
    const onFollowUp = vi.fn(async (): Promise<StepEngineOutcome> => ({}));
    const handlers: StepExecutorHandlers = {
      onPrompt: vi.fn(async (): Promise<StepEngineOutcome> => ({})),
      onToolCall: vi.fn(),
      onFollowUp,
    };
    await executeSteps({
      steps: [{ id: "p", kind: "prompt", prompt: "Show me a redbull" }],
      state: createStepExecutionState(),
      browser: makeBrowser({
        drainFollowUps: vi
          .fn<() => string[]>()
          .mockReturnValueOnce(["auto-sent"])
          .mockReturnValue([]),
      }),
      handlers,
    });
    expect(onFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ text: "auto-sent", turnOrdinal: 0 }),
    );
  });

  it("bounds runaway follow-ups at MAX_WIDGET_FOLLOWUP_TURNS per step", async () => {
    // A single prompt step + a widget that re-sends on every render: the per-step
    // budget caps the loop (the budget resets for each authored step).
    const drainFollowUps = vi.fn(() => ["again"]);
    const onFollowUp = vi.fn(
      async (): Promise<StepEngineOutcome> => ({ toolCalls: [] }),
    );
    const handlers: StepExecutorHandlers = {
      onPrompt: vi.fn(async (): Promise<StepEngineOutcome> => ({})),
      onToolCall: vi.fn(),
      onFollowUp,
    };
    await executeSteps({
      steps: [{ id: "p", kind: "prompt", prompt: "x" }],
      state: createStepExecutionState(),
      browser: makeBrowser({ drainFollowUps }),
      handlers,
    });
    expect(onFollowUp).toHaveBeenCalledTimes(MAX_WIDGET_FOLLOWUP_TURNS);
  });

  it("fail-fasts the iteration when a follow-up turn errors", async () => {
    const handlers: StepExecutorHandlers = {
      onPrompt: vi.fn(async (): Promise<StepEngineOutcome> => ({})),
      onToolCall: vi.fn(),
      onFollowUp: vi.fn(
        async (): Promise<StepEngineOutcome> => ({
          iterationError: "engine blew up",
        }),
      ),
    };
    const result = await executeSteps({
      steps: SEARCH_AND_CLICK,
      state: createStepExecutionState(),
      browser: makeBrowser({ drainFollowUps: vi.fn(() => ["x"]) }),
      handlers,
    });
    expect(result.iterationError).toContain("engine blew up");
  });
});
