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

const prompt = (id: string): TestStep => ({ id, kind: "prompt", prompt: id });
const turnCountUnder = (id: string, turns: number): TestStep => ({
  id,
  kind: "assert",
  assertion: { type: "turnCountUnder", turns },
});

// Each prompt step reports the user turn it sent and the reply, the way the
// hosted and local handlers slice their message history; `extra` adds what a
// step saw in between.
async function run(steps: TestStep[], extra: StepEngineOutcome = {}) {
  const state = createStepExecutionState();
  await executeSteps({
    steps,
    state,
    browser: makeBrowser(),
    handlers: {
      onPrompt: vi.fn(async ({ step }): Promise<StepEngineOutcome> => ({
        ...extra,
        messages: [
          { role: "user", content: step.prompt },
          ...(extra.messages ?? []),
          { role: "assistant", content: "ok" },
        ],
        toolCalls: [],
      })),
      onToolCall: vi.fn(),
    },
  });
  return state.assertionResults;
}

describe("step-executor turnCountUnder assert", () => {
  it("passes when the run stayed under the limit", async () => {
    const [result] = await run([prompt("p0"), turnCountUnder("a", 4)]);
    expect(result!.reason).toContain("1 user turn(s), fewer than 4");
    expect(result!.passed).toBe(true);
  });

  it("counts every user turn so far, and fails at the limit", async () => {
    const [result] = await run([
      prompt("p0"),
      prompt("p1"),
      prompt("p2"),
      turnCountUnder("a", 3),
    ]);
    expect(result!.reason).toContain("3 user turn(s) is not fewer than 3");
    expect(result!.passed).toBe(false);
  });

  it("counts only the turns before the assert", async () => {
    const [early, late] = await run([
      prompt("p0"),
      turnCountUnder("a", 2),
      prompt("p1"),
      turnCountUnder("b", 2),
    ]);
    expect(early!.reason).toContain("1 user turn(s), fewer than 2");
    expect(late!.reason).toContain("2 user turn(s) is not fewer than 2");
  });

  it("reads a step's tool error once, not again from its messages", async () => {
    const [result] = await run(
      [
        prompt("p0"),
        { id: "a", kind: "assert", assertion: { type: "noToolErrors" } },
      ],
      {
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "list_projects",
                output: { type: "error-text", value: "boom" },
              },
            ],
          },
        ],
        toolErrors: [
          {
            kind: "protocol-error",
            toolName: "list_projects",
            message: "boom",
          },
        ],
      },
    );
    expect(result!.reason).toContain("1 tool error(s)");
  });
});
