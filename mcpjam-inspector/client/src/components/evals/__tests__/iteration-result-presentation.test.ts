import { describe, it, expect } from "vitest";
import {
  getIterationResultDisplayLabel,
  getIterationResultBadgeClass,
  suitePassCriteriaCompactBadgeClassNames,
} from "../iteration-result-presentation";
import type { EvalIteration } from "../types";

function baseIteration(overrides: Partial<EvalIteration> = {}): EvalIteration {
  return {
    _id: "i1",
    createdBy: "u",
    createdAt: 1,
    iterationNumber: 1,
    updatedAt: 2,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    testCaseSnapshot: {
      title: "T",
      query: "q",
      provider: "openai",
      model: "m",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

describe("getIterationResultDisplayLabel", () => {
  it("returns Running when status is running", () => {
    expect(
      getIterationResultDisplayLabel(
        baseIteration({ status: "running", result: "pending" }),
      ),
    ).toBe("Running");
  });

  it("returns Failed for a failed result", () => {
    expect(
      getIterationResultDisplayLabel(
        baseIteration({
          result: "failed",
          resultSource: "reported",
          status: "completed",
        }),
      ),
    ).toBe("Failed");
  });
});

describe("getIterationResultBadgeClass", () => {
  it("uses pastel destructive surface for failed", () => {
    expect(
      getIterationResultBadgeClass(
        baseIteration({
          result: "failed",
          resultSource: "reported",
          status: "completed",
        }),
      ),
    ).toContain("bg-destructive/50");
  });
});

describe("suitePassCriteriaCompactBadgeClassNames", () => {
  it("uses pastel destructive surface for failed suite outcome", () => {
    const classes = suitePassCriteriaCompactBadgeClassNames("failed");
    expect(classes).toContain("bg-destructive/50");
    expect(classes).toContain("text-[10px]");
  });

  it("uses pastel success for passed and pastel warning for passed_with_failures", () => {
    expect(suitePassCriteriaCompactBadgeClassNames("passed")).toContain(
      "bg-success/50",
    );
    expect(
      suitePassCriteriaCompactBadgeClassNames("passed_with_failures"),
    ).toContain("bg-warning/50");
  });
});
