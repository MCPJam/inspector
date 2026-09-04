/**
 * The WIRE from a classified provider failure to an attributed chain.
 *
 * Every other provider-error test builds a `StageEvidence` with `stepError`
 * already on it and asserts what the analyzer does with it. None of them
 * exercises the plumbing that is supposed to PUT it there — and that gap is why
 * four independent breaks in that plumbing all shipped green:
 *
 *   - the hosted bridge in `step-handlers` copied only the error message;
 *   - the widget follow-up loop reduced a full outcome to a bare string;
 *   - the local driver carried no source at all;
 *   - the judge second pass re-derived without it.
 *
 * So these tests run the REAL `executeSteps` over real handler outcomes and
 * assert the attribution survives each hop. A unit test of the analyzer cannot
 * fail when the wire is cut; these can.
 */
import { describe, it, expect, vi } from "vitest";
import type { TestStep } from "@/shared/steps";

// Mocked so the HOSTED BRIDGE itself is under test: `buildHostedStepHandlers`
// converts a `HostedEvalTurnOutcome` into a `StepEngineOutcome`, and that
// conversion is where the attribution was being dropped.
const { driveHostedEvalTurnMock } = vi.hoisted(() => ({
  driveHostedEvalTurnMock: vi.fn(),
}));
vi.mock("../drive-hosted-eval-turn", async () => {
  const actual = await vi.importActual<
    typeof import("../drive-hosted-eval-turn")
  >("../drive-hosted-eval-turn");
  return { ...actual, driveHostedEvalTurn: driveHostedEvalTurnMock };
});

import {
  createStepExecutionState,
  executeSteps,
  type StepEngineOutcome,
  type StepExecutorHandlers,
} from "../step-executor";
import { buildHostedStepHandlers } from "../step-handlers";
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

/** What a hosted turn returns when our own model call died. */
const PROVIDER_DIED: StepEngineOutcome = {
  iterationError: "credit balance too low",
  iterationErrorDetails: "Anthropic API",
  errorSource: "model",
  errorCode: "billing_limit_reached",
  errorHttpStatus: 429,
};

const ONE_PROMPT: TestStep[] = [
  { id: "p", kind: "prompt", prompt: "Find my order" },
];

function run(
  steps: TestStep[],
  handlers: Partial<StepExecutorHandlers>,
  browser = makeBrowser(),
) {
  return executeSteps({
    steps,
    state: createStepExecutionState(),
    browser: browser as unknown as BrowserSessionContext,
    handlers: {
      onPrompt: vi.fn(async () => ({}) as StepEngineOutcome),
      onToolCall: vi.fn(async () => ({}) as StepEngineOutcome),
      ...handlers,
    } as StepExecutorHandlers,
  });
}

describe("a classified provider failure reaches the runner", () => {
  it("carries source, code and status off a failed prompt turn", async () => {
    // The main hosted path, and the one the audited Anthropic-credit trials
    // ran on. Before this the executor received only `iterationError`, so
    // `iterationStepError` was never built and NO hosted run was attributed.
    const result = await run(ONE_PROMPT, {
      onPrompt: vi.fn(async () => PROVIDER_DIED),
    });

    expect(result.iterationError).toBe("credit balance too low");
    expect(result.errorSource).toBe("model");
    // Diagnostics ride along; they are never the basis for the classification.
    expect(result.errorCode).toBe("billing_limit_reached");
    expect(result.errorHttpStatus).toBe(429);
  });

  it("carries the same attribution off a widget FOLLOW-UP turn", async () => {
    // A turn that dies on the provider is the same event whether it was the
    // prompt or a `ui/message` follow-up. Reporting one and not the other made
    // the attribution depend on which turn the model happened to fail on.
    const browser = makeBrowser({
      drainFollowUps: vi
        .fn()
        .mockReturnValueOnce(["add the red one"])
        .mockReturnValue([]),
    });

    const result = await run(
      [
        { id: "p", kind: "prompt", prompt: "Show me a redbull" },
        {
          id: "i",
          kind: "interact",
          toolName: "search-products",
          action: { kind: "click", target: { text: "🛒" } },
        },
      ],
      {
        onPrompt: vi.fn(async () => ({}) as StepEngineOutcome),
        onFollowUp: vi.fn(async () => PROVIDER_DIED),
      },
      browser,
    );

    expect(result.iterationError).toBe("credit balance too low");
    expect(result.errorSource).toBe("model");
    expect(result.errorHttpStatus).toBe(429);
  });

  it("says nothing when the engine classified nothing", async () => {
    // The compatibility floor, end to end. A handler that cannot name the
    // layer must leave the source absent rather than have the wire invent one.
    const result = await run(ONE_PROMPT, {
      onPrompt: vi.fn(async () => ({
        iterationError: "something went wrong",
      })),
    });

    expect(result.iterationError).toBe("something went wrong");
    expect(result.errorSource).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  it("says nothing about a turn that did not fail", async () => {
    const result = await run(ONE_PROMPT, {
      onPrompt: vi.fn(async () => ({}) as StepEngineOutcome),
    });
    expect(result.iterationError).toBeUndefined();
    expect(result.errorSource).toBeUndefined();
  });
});

describe("the hosted bridge does not drop what the engine classified", () => {
  it("converts a classified turn outcome into an attributed step outcome", async () => {
    // THE BREAK THIS FILE EXISTS FOR. `driveHostedEvalTurn` classifies the
    // failure; `buildHostedStepHandlers` converts its outcome for the executor.
    // That conversion copied only the message, so the classification died one
    // hop from where it was made and every hosted run went unattributed.
    driveHostedEvalTurnMock.mockResolvedValue({
      kind: "failed",
      iterationError: "credit balance too low",
      iterationErrorDetails: "Anthropic API",
      errorSource: "model",
      errorCode: "billing_limit_reached",
      errorHttpStatus: 429,
    });

    const handlers = buildHostedStepHandlers({
      acc: {
        messageHistory: [],
        capturedSpans: [],
        accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        toolsCalledByPrompt: [],
        assistantMessageByPrompt: [],
        toolErrorsByPrompt: [],
        pinnedToolErrors: [],
      },
      browser: {
        setActivePromptIndex: vi.fn(),
        setActiveWidgetChecks: vi.fn(),
        dismissCarriedWidget: vi.fn(async () => {}),
      },
    } as never);

    const outcome = await handlers.onPrompt({
      step: { id: "p", kind: "prompt", prompt: "Find my order" },
      stepIndex: 0,
      turnOrdinal: 0,
    } as never);

    expect(outcome.iterationError).toBe("credit balance too low");
    expect(outcome.errorSource).toBe("model");
    expect(outcome.errorCode).toBe("billing_limit_reached");
    expect(outcome.errorHttpStatus).toBe(429);
  });
});
