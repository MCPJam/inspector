import { describe, it, expect, vi } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  createStepExecutionState,
  executeSteps,
  type StepEngineOutcome,
} from "../step-executor";
import type { BrowserSessionContext } from "../../browser-session-context";
import {
  createInputAnswerResolver,
  runWithIterationExchanges,
  withToolCallScope,
} from "../input-answers.js";

// An `inputAnswered` assert step reads the questions the iteration's servers
// asked so far. The case-level verdict already did; the step path built its
// transcript without them, so the check failed "no question from a server was
// recorded" while the trace showed the Question span.

const browser = {
  setActivePromptIndex: vi.fn(),
  setActiveAuthoredStepId: vi.fn(),
  setKeepWidgetsMountedForSteps: vi.fn(),
  replayInteractStep: vi.fn(async () => ({ ok: true })),
  evaluateWidgetAssertion: vi.fn(async () => ({ ok: true })),
  widgetRenderObservations: [],
  drainFollowUps: vi.fn(() => []),
} as unknown as BrowserSessionContext;

const prompt: TestStep = { id: "p0", kind: "prompt", prompt: "Clean up." };
const answered = (assertion: object): TestStep =>
  ({ id: "a", kind: "assert", assertion }) as TestStep;

async function runAskingAnIterationQuestion(
  replies: Parameters<typeof createInputAnswerResolver>[0]["answers"],
  steps: TestStep[],
  ask: boolean,
) {
  const resolver = createInputAnswerResolver({ answers: replies });
  const state = createStepExecutionState();
  await runWithIterationExchanges(() =>
    executeSteps({
      steps,
      state,
      browser,
      handlers: {
        onPrompt: vi.fn(async ({ step }): Promise<StepEngineOutcome> => {
          if (ask) {
            await withToolCallScope({ tool: "cleanup" }, () =>
              resolver.elicitationCallback({
                requestId: "r",
                message: "Delete /tmp?",
                schema: {},
                serverId: "files",
              }),
            );
          }
          return {
            messages: [
              { role: "user", content: step.prompt },
              { role: "assistant", content: "ok" },
            ],
            toolCalls: [],
          };
        }),
        onToolCall: vi.fn(),
      },
    }),
  );
  return state.assertionResults[0];
}

describe("an inputAnswered assert step", () => {
  it("passes when the question was asked and the case's reply answered it", async () => {
    const result = await runAskingAnIterationQuestion(
      [{ message: "Delete", action: "accept", content: { sure: true } }],
      [prompt, answered({ type: "inputAnswered", action: "accept" })],
      true,
    );
    expect(result).toMatchObject({ passed: true });
  });

  it("fits action decline when the question went unanswered", async () => {
    const result = await runAskingAnIterationQuestion(
      [],
      [prompt, answered({ type: "inputAnswered", action: "decline" })],
      true,
    );
    expect(result).toMatchObject({ passed: true });
  });

  it("fails, saying no question was recorded, when no server asked", async () => {
    const result = await runAskingAnIterationQuestion(
      [],
      [prompt, answered({ type: "inputAnswered" })],
      false,
    );
    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringContaining("no question from a server was recorded"),
    });
  });
});
