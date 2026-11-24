import { describe, expect, it } from "vitest";
import { buildEvalIterationVerdict } from "../iteration-verdict.js";
import {
  createInputAnswerResolver,
  currentIterationExchanges,
  runWithIterationExchanges,
  withToolCallScope,
} from "../input-answers.js";

function verdictWith(predicate: object) {
  return buildEvalIterationVerdict({
    promptTurns: [{ id: "turn-1", prompt: "Clean up.", expectedToolCalls: [] }],
    toolsCalledByPrompt: [[]],
    isNegativeTest: true,
    matchOptions: {},
    turnCheckResults: [],
    effectivePredicates: [predicate as never],
    trace: { messages: [] },
    usage: undefined,
    renderObservations: undefined,
    inputExchanges: [...currentIterationExchanges()],
    failOnToolError: false,
    pinnedToolErrors: [],
    scriptedCheckFailures: [],
  });
}

describe("a question and its reply as a check", () => {
  const resolver = createInputAnswerResolver({
    answers: [{ message: "Delete", action: "accept", content: { sure: true } }],
  });
  const ask = () =>
    withToolCallScope({ tool: "cleanup" }, () =>
      resolver.elicitationCallback({
        requestId: "r",
        message: "Delete /tmp?",
        schema: {},
        serverId: "files",
      }),
    );

  it("passes for the iteration that asked, and the exchange is not a tool call", async () => {
    const result = await runWithIterationExchanges(async () => {
      await ask();
      return verdictWith({
        type: "inputAnswered",
        tool: "cleanup",
        action: "accept",
      });
    });
    expect(result.predicateResults[0]).toMatchObject({ passed: true });
    // The case expected no tool call, and a question is not one.
    expect(result.evaluation.toolsCalled).toEqual([]);
    expect(result.evaluation.passed).toBe(true);
  });

  it("does not see the questions of another iteration", async () => {
    await runWithIterationExchanges(() => ask());
    const other = await runWithIterationExchanges(async () =>
      verdictWith({ type: "inputAnswered" }),
    );
    expect(other.predicateResults[0]).toMatchObject({
      passed: false,
      reason: expect.stringContaining("no question from a server was recorded"),
    });
  });
});
