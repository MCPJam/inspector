import { describe, it, expect, vi } from "vitest";
import type { TestStep } from "@/shared/steps";
import { parseStepStatusById } from "@/shared/eval-step-replay";
import { DECLARED_OUTPUT_SCHEMA } from "@mcpjam/sdk/predicates";
import { buildStepResultRecords } from "../step-verdict-adapters";
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

describe("step-executor declared-schema assert", () => {
  it.each([
    { withSchema: true, status: "ok" },
    { withSchema: false, status: "not_applicable" },
  ])("preserves $status in live and recorded step replay", async ({ withSchema, status }) => {
    const state = createStepExecutionState({
      declarationsCaptured: "complete",
      // Without a schema, the tool is still declared: a result with no
      // matching declaration is unvalidated, not Not applicable.
      toolDeclarations: [
        {
          serverKey: "shop",
          name: "get_order",
          inputSchema: { type: "object" },
          ...(withSchema
            ? {
                outputSchema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                  required: ["status"],
                },
              }
            : {}),
        },
      ],
    });
    const steps: TestStep[] = [
      prompt("p0"),
      {
        id: "a",
        kind: "assert",
        assertion: { type: "toolResultMatchesSchema", schema: DECLARED_OUTPUT_SCHEMA },
      },
      prompt("p1"),
    ];
    const onStepStatus = vi.fn();
    await executeSteps({
      steps,
      onStepStatus,
      state,
      browser: makeBrowser(),
      handlers: {
        onPrompt: vi.fn(async ({ step }): Promise<StepEngineOutcome> => ({
          messages: [
            { role: "user", content: step.prompt },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "c1",
                  toolName: "get_order",
                  output: { type: "json", value: { status: "ok" } },
                  result: { structuredContent: { status: "ok" } },
                },
              ],
            },
            { role: "assistant", content: "ok" },
          ],
          toolCalls: [],
        })),
        onToolCall: vi.fn(),
      },
    });
    const [result] = state.assertionResults;
    expect(result?.passed).toBe(true);
    expect(onStepStatus).toHaveBeenCalledWith(expect.objectContaining({ stepId: "a", status }));
    expect(onStepStatus).toHaveBeenCalledWith(expect.objectContaining({ stepId: "p1", status: "ok" }));
    const records = buildStepResultRecords(state, steps);
    expect(parseStepStatusById({ stepResults: records }).get("a")).toBe(status);
  });
});
