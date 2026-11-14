import { describe, expect, it } from "vitest";
import { buildEvalIterationVerdict } from "../iteration-verdict.js";
import type { ToolCall } from "../types.js";

// The first lookup failed, the model called it again and it worked, and the
// answer was right. The harness records the failure as an errored tool span.
const lookup = (toolCallId: string): ToolCall => ({
  toolName: "get_user",
  arguments: { email: "sam@example.com" },
  toolCallId,
});
const recoveredTrace = {
  messages: [],
  spans: [
    {
      id: "span-1",
      name: "get_user",
      category: "tool" as const,
      startMs: 0,
      endMs: 60,
      status: "error" as const,
      toolCallId: "call-1",
    },
  ],
};

function verdict(args: {
  failOnToolError: boolean;
  iterationError?: string;
  negative?: boolean;
}) {
  return buildEvalIterationVerdict({
    promptTurns: [
      {
        id: "turn-1",
        prompt: "Who is sam@example.com?",
        expectedToolCalls: args.negative
          ? []
          : [{ toolName: "get_user", arguments: { email: "sam@example.com" } }],
      },
    ],
    toolsCalledByPrompt: [
      args.negative ? [] : [lookup("call-1"), lookup("call-2")],
    ],
    isNegativeTest: args.negative === true,
    matchOptions: {},
    turnCheckResults: [],
    effectivePredicates: undefined,
    trace: args.negative ? { messages: [] } : recoveredTrace,
    usage: undefined,
    renderObservations: undefined,
    iterationError: args.iterationError,
    failOnToolError: args.failOnToolError,
    pinnedToolErrors: [],
    scriptedCheckFailures: [],
  });
}

describe("a tool error the model recovered from", () => {
  it("fails the case while tool errors fail it, which is the default", () => {
    const { evaluation, passed } = verdict({ failOnToolError: true });
    expect(evaluation.passed).toBe(true);
    expect(passed).toBe(false);
  });

  it("passes once the case stops failing on tool errors", () => {
    expect(verdict({ failOnToolError: false }).passed).toBe(true);
  });
});

describe("a turn that did not finish, with tool errors forgiven", () => {
  it("still fails when every expected call was made", () => {
    const { evaluation, passed } = verdict({
      failOnToolError: false,
      iterationError: "Model stream ended before the turn finished",
    });
    expect(evaluation.passed).toBe(true);
    expect(passed).toBe(false);
  });

  it("still fails a negative case that made no calls", () => {
    const { evaluation, passed } = verdict({
      failOnToolError: false,
      iterationError: "Model stream ended before the turn finished",
      negative: true,
    });
    expect(evaluation.passed).toBe(true);
    expect(passed).toBe(false);
  });

  it("ignores a blank error, as the shared gate does", () => {
    expect(
      verdict({ failOnToolError: false, iterationError: "  " }).passed,
    ).toBe(true);
  });
});
