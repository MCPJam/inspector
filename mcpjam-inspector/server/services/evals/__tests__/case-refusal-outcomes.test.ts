import { describe, expect, it } from "vitest";
import { isBearerRefusal } from "../../../utils/run-bearer.js";
import {
  completedBeforeRefusal,
  countIterationOutcomes,
  keepCompletedOnRefusal,
} from "../case-refusal-outcomes.js";

const REFUSAL = "token_renewal_failed: lease_lost";
const passed = { evaluation: { passed: true } };
const failed = { evaluation: { passed: false }, policyBlockCount: 1 };

/** A case that completes `outcomes`, then throws `error`. */
function caseThat(outcomes: Array<typeof passed>, error: Error) {
  return async (completed: Array<typeof passed>) => {
    completed.push(...outcomes);
    throw error;
  };
}

describe("keepCompletedOnRefusal", () => {
  it("hands a refused job token on with the outcomes completed before it", async () => {
    const reason = await keepCompletedOnRefusal(
      caseThat([passed, failed], new Error(REFUSAL)),
    ).catch((error: unknown) => error);
    expect(isBearerRefusal(reason)).toBe(true);
    expect((reason as Error).message).toBe(REFUSAL);
    expect(completedBeforeRefusal(reason)).toEqual([passed, failed]);
  });

  it("leaves any other rejection, and a refusal with nothing completed, as it was", async () => {
    const other = new Error("boom");
    const refusal = new Error(REFUSAL);
    for (const [outcomes, error] of [
      [[passed], other],
      [[], refusal],
    ] as const) {
      const reason = await keepCompletedOnRefusal(
        caseThat([...outcomes], error),
      ).catch((caught: unknown) => caught);
      expect(reason).toBe(error);
      expect(completedBeforeRefusal(reason)).toEqual([]);
    }
  });

  it("returns a completed case's outcomes unchanged", async () => {
    expect(
      await keepCompletedOnRefusal(async (completed) => {
        completed.push(passed);
        return completed;
      }),
    ).toEqual([passed]);
  });
});

describe("countIterationOutcomes", () => {
  it("counts each measured outcome and leaves an infra trial out", () => {
    const summary = {
      total: 0,
      passed: 0,
      failed: 0,
      policyBlockedIterations: 0,
    };
    countIterationOutcomes(summary, [
      passed,
      failed,
      { evaluation: { passed: false }, infraError: { kind: "provider" } },
    ]);
    expect(summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      policyBlockedIterations: 1,
    });
  });
});
