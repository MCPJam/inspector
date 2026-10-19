import { describe, it, expect, vi } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  createStepExecutionState,
  executeSteps,
  type StepEngineOutcome,
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

function makeBrowser(): BrowserMock {
  return {
    setActivePromptIndex: vi.fn(),
    setActiveAuthoredStepId: vi.fn(),
    setKeepWidgetsMountedForSteps: vi.fn(),
    replayInteractStep: vi.fn(async () => ({ ok: true })),
    evaluateWidgetAssertion: vi.fn(async () => ({ ok: true })),
    widgetRenderObservations: [],
    drainFollowUps: vi.fn(() => []),
  };
}

// Each prompt step reports the user turn it sent and the reply, the way the
// hosted and local handlers slice their message history.
async function runWithTurnCountAssert(prompts: string[], turns: number) {
  const steps: TestStep[] = [
    ...prompts.map((prompt, i): TestStep => ({
      id: `p${i}`,
      kind: "prompt",
      prompt,
    })),
    { id: "a", kind: "assert", assertion: { type: "turnCountUnder", turns } },
  ];
  const state = createStepExecutionState();
  await executeSteps({
    steps,
    state,
    browser: makeBrowser(),
    handlers: {
      onPrompt: vi.fn(async ({ step }): Promise<StepEngineOutcome> => ({
        messages: [
          { role: "user", content: step.prompt },
          { role: "assistant", content: "ok" },
        ],
        toolCalls: [],
      })),
      onToolCall: vi.fn(),
    },
  });
  return state.assertionResults[0]!;
}

describe("step-executor turnCountUnder assert", () => {
  it("passes when the run stayed under the limit", async () => {
    const result = await runWithTurnCountAssert(["How many projects?"], 4);
    expect(result.reason).toContain("1 user turn(s), fewer than 4");
    expect(result.passed).toBe(true);
  });

  it("counts every user turn so far, and fails at the limit", async () => {
    const result = await runWithTurnCountAssert(["one", "two", "three"], 3);
    expect(result.reason).toContain("3 user turn(s) is not fewer than 3");
    expect(result.passed).toBe(false);
  });
});
