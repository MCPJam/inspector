import { describe, expect, it } from "vitest";
import type { EvalCase, EvalSuite } from "../../../evals/types";
import { executionPreviewInputFor } from "../test-run-preview-input";
import { SUITE, TEST_CASE } from "./test-run-fixtures";

const bareSuite = { _id: "s", name: "S" } as EvalSuite;

describe("executionPreviewInputFor", () => {
  it("maps a saved case and its suite as the editor seeds them", () => {
    const input = executionPreviewInputFor(TEST_CASE, SUITE);
    expect(input.steps.map((step) => step.id)).toEqual(["p0", "a1", "a2"]);
    expect(input.toolsChoice).toBe("tools");
    expect(input.expectedOutput).toBe(TEST_CASE.expectedOutput);
    expect(input.suiteDefaultPredicates).toBe(SUITE.defaultPredicates);
    expect(input.suiteJudgeConfig).toBe(SUITE.judgeConfig);
  });

  it("answers no tool for a negative test with no tool asserts", () => {
    const negative = {
      ...TEST_CASE,
      steps: [{ id: "p0", kind: "prompt", prompt: "hi" }],
      isNegativeTest: true,
    } as EvalCase;
    expect(executionPreviewInputFor(negative, bareSuite).toolsChoice).toBe(
      "noTool",
    );
  });

  it("falls back to the legacy prompt when the case has no steps", () => {
    const legacy = {
      ...TEST_CASE,
      steps: undefined,
      query: "Old prompt",
    } as EvalCase;
    const input = executionPreviewInputFor(legacy, bareSuite);
    expect(input.steps[0]).toMatchObject({
      kind: "prompt",
      prompt: "Old prompt",
    });
    expect(input.toolsChoice).toBe("unset");
  });

  it("reads absent suite defaults as none", () => {
    expect(
      executionPreviewInputFor(TEST_CASE, bareSuite).suiteDefaultPredicates,
    ).toEqual([]);
  });
});
