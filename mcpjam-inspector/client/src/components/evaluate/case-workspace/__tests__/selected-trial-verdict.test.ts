import { describe, expect, it } from "vitest";
import type {
  CompareRunRecord,
  EvalIteration,
} from "../../../evals/types";
import { trialVerdict } from "../selected-trial";

/**
 * The Quick Run badge shows the verdict the hosted runner stored. That verdict
 * already applies the case's `failOnToolError`, so a trial whose only problem
 * was an errored tool call reads as failed here even though its tool calls
 * satisfy the expectations. The badge must not regrade the trial from its tool
 * calls, which would turn that failure into a pass.
 */
function hostedIteration(result: "passed" | "failed"): EvalIteration {
  return {
    _id: "iter1",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    iterationNumber: 1,
    status: "completed",
    result,
    resultSource: "reported",
    testCaseSnapshot: {
      expectedToolCalls: [{ toolName: "search_tasks", arguments: {} }],
    },
    actualToolCalls: [
      { toolName: "search_tasks", arguments: { status: "opn" } },
      { toolName: "search_tasks", arguments: { status: "open" } },
    ],
    tokensUsed: 100,
  } as EvalIteration;
}

function liveRecord(iteration: EvalIteration): CompareRunRecord {
  return {
    modelValue: "m",
    modelLabel: "Model",
    provider: "p",
    model: "m",
    status: "completed",
    iteration,
    startedAt: 0,
    completedAt: 1,
    result: iteration.result,
  } as CompareRunRecord;
}

describe("the Quick Run badge shows the stored hosted verdict", () => {
  it("shows Failed for a trial that failed on a tool error", () => {
    const iteration = hostedIteration("failed");
    expect(
      trialVerdict({ kind: "persisted", iteration, source: "latest" }).word,
    ).toBe("Failed");
    expect(trialVerdict({ kind: "live", record: liveRecord(iteration) }).word).toBe(
      "Failed",
    );
  });

  it("shows Passed when the case set failOnToolError to false", () => {
    const iteration = hostedIteration("passed");
    expect(
      trialVerdict({ kind: "persisted", iteration, source: "latest" }).word,
    ).toBe("Passed");
    expect(trialVerdict({ kind: "live", record: liveRecord(iteration) }).word).toBe(
      "Passed",
    );
  });
});
