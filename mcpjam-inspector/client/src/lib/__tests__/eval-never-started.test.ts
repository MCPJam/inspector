/**
 * A launch refused before anything ran stores its reason on every iteration
 * (`markSetupPendingIterationsFailed`). The run page leads with that reason
 * instead of "Connection error: Failed to prepare eval test attempts.".
 */
import { describe, expect, it } from "vitest";
import { buildRunErrorBreakdown } from "@/components/evaluate/run-error-breakdown-model";
import type { EvalIteration } from "@/components/evals/types";
import { describeEvalIterationError, neverStartedReason } from "../eval-iteration-error";

const NOT_STARTED = "Failed to prepare eval test attempts.";
const REASON =
  "Couldn't run Claude Code on this machine because it isn't set up for this project. Set it up in the Playground, then run the eval again.";

function iteration(id: string, overrides: Partial<EvalIteration> = {}): EvalIteration {
  return {
    _id: id,
    testCaseId: `case_${id}`,
    status: "failed",
    result: "failed",
    iterationNumber: 1,
    actualToolCalls: [],
    tokensUsed: 0,
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    error: NOT_STARTED,
    errorDetails: REASON,
    testCaseSnapshot: { title: "Refund", query: "Refund it", provider: "anthropic", model: "sonnet", expectedToolCalls: [] },
    ...overrides,
  } as EvalIteration;
}

describe("a run that never started", () => {
  it("headlines the stored reason", () => {
    expect(describeEvalIterationError(iteration("a"))).toMatchObject({
      slug: "eval/not_started",
      title: "Run didn't start",
      severity: "error",
      oneLine: REASON,
      nextSteps: [],
    });
  });

  it.each([
    ["JSON", '{"code":"HARNESS_UNAVAILABLE"}'],
    ["a request id", "[Request ID: 1234] Server Error"],
    ["a stack trace", "TypeError: boom\n    at run (evals-runner.ts:1)"],
    ["a raw lower-case cause", "fetch failed"],
    ["a machine code", "TOOL_POLICY_UNSUPPORTED: COMPUTERS_TERMINAL_TOKEN_SECRET is absent on this deployment."],
    ["nothing", undefined],
  ])("keeps the generic card when the stored cause is %s", (_label, errorDetails) => {
    expect(neverStartedReason(iteration("a", { errorDetails }))).toBeNull();
    expect(describeEvalIterationError(iteration("a", { errorDetails }))?.slug).not.toBe("eval/not_started");
  });

  it("applies only to the launch's own constant on a failed iteration", () => {
    expect(neverStartedReason(iteration("a", { error: "Could not connect to the server." }))).toBeNull();
    expect(neverStartedReason(iteration("a", { status: "setup_failed" }))).toBeNull();
  });

  it("groups the iterations under the reason in the run's failure breakdown", () => {
    const breakdown = buildRunErrorBreakdown({ iterations: [iteration("a"), iteration("b")] });
    expect(breakdown?.groups).toEqual([
      { cause: "notStarted", title: "The run didn't start", count: 2, errors: [{ message: REASON, count: 2 }] },
    ]);
  });
});
