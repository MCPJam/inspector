import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { startSuiteRunWithRecorder } from "../recorder.js";
import {
  CODE_EVALUATORS_UNAVAILABLE,
  codeEvaluatorRunRefusalError,
} from "../sandbox-phases/run-refusal.js";

const MESSAGE =
  "This suite has setup or cleanup scripts, files to copy or a Required code evaluator, which this Inspector can’t run because it can’t start eval sandboxes. Run it from MCPJam, or remove them. The run was not started.";

describe("a run the backend refuses for its code evaluators or scripts", () => {
  it("starts nothing and answers 400 with the backend's text and reason", async () => {
    const mutation = vi.fn().mockRejectedValueOnce(
      new ConvexError({ code: CODE_EVALUATORS_UNAVAILABLE, message: MESSAGE, reason: "runner_without_sandboxes" }),
    );
    const action = vi.fn();
    await expect(
      startSuiteRunWithRecorder({ convexClient: { mutation, action } as any, suiteId: "suite-1" }),
    ).rejects.toMatchObject({
      status: 400,
      message: MESSAGE,
      details: { reason: CODE_EVALUATORS_UNAVAILABLE, rule: "runner_without_sandboxes" },
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("leaves every other backend error as it was", () => {
    expect(codeEvaluatorRunRefusalError(new ConvexError({ code: "SOMETHING_ELSE", message: "no" }))).toBeNull();
    expect(codeEvaluatorRunRefusalError(new ConvexError({ code: CODE_EVALUATORS_UNAVAILABLE }))).toBeNull();
    expect(codeEvaluatorRunRefusalError(new Error(CODE_EVALUATORS_UNAVAILABLE))).toBeNull();
  });
});
