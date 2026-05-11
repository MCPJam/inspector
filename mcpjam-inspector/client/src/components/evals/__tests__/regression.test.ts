import { describe, it, expect } from "vitest";
import {
  computeSuiteRegression,
  executionConfigKeyForIteration,
} from "../regression";
import type { EvalIteration } from "../types";

function makeIteration(
  overrides: Partial<EvalIteration> & {
    testCaseId: string;
    result: EvalIteration["result"];
    provider?: string;
    model?: string;
  },
): EvalIteration {
  const { provider, model, ...rest } = overrides;
  return {
    _id: `it-${Math.random().toString(36).slice(2)}`,
    testCaseId: rest.testCaseId,
    projectId: "p-1",
    testCaseSnapshot: {
      title: "t",
      query: "q",
      provider: provider ?? "anthropic",
      model: model ?? "claude-haiku",
      expectedToolCalls: [],
    } as unknown as EvalIteration["testCaseSnapshot"],
    suiteRunId: "sr-current",
    createdBy: "u-1",
    createdAt: 0,
    iterationNumber: 1,
    updatedAt: 0,
    status: "completed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...rest,
  } as EvalIteration;
}

describe("computeSuiteRegression", () => {
  it("flags a pass-rate drop above the threshold", () => {
    const prev: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
    ]; // 5/5 = 100%
    const cur: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "failed" }),
      makeIteration({ testCaseId: "tc1", result: "failed" }),
      makeIteration({ testCaseId: "tc1", result: "failed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
    ]; // 2/5 = 40%
    const report = computeSuiteRegression(cur, prev, 10);
    expect(report.comparable).toHaveLength(1);
    const entry = report.comparable[0];
    expect(entry.previousPassRate).toBe(1);
    expect(entry.currentPassRate).toBe(0.4);
    expect(entry.drop).toBeCloseTo(0.6);
    expect(entry.exceededThreshold).toBe(true);
    expect(report.regressedCount).toBe(1);
  });

  it("does NOT flag drops within the threshold", () => {
    const prev: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
    ];
    const cur: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc1", result: "failed" }),
    ]; // 4/5 = 80% — drop is 20%, threshold strictly > 10% so still flags
    // Use a higher threshold to stay below the flag
    const report = computeSuiteRegression(cur, prev, 25);
    expect(report.regressedCount).toBe(0);
    expect(report.comparable[0].exceededThreshold).toBe(false);
  });

  it("groups by (testCaseId, executionConfigKey) so different models don't collide", () => {
    const prev: EvalIteration[] = [
      makeIteration({
        testCaseId: "tc1",
        provider: "anthropic",
        model: "claude-haiku",
        result: "passed",
      }),
      makeIteration({
        testCaseId: "tc1",
        provider: "openai",
        model: "gpt-4o",
        result: "failed",
      }),
    ];
    const cur: EvalIteration[] = [
      makeIteration({
        testCaseId: "tc1",
        provider: "anthropic",
        model: "claude-haiku",
        result: "passed",
      }),
      makeIteration({
        testCaseId: "tc1",
        provider: "openai",
        model: "gpt-4o",
        result: "passed",
      }),
    ];
    const report = computeSuiteRegression(cur, prev, 10);
    expect(report.comparable).toHaveLength(2);
    const keys = new Set(report.comparable.map((c) => c.executionConfigKey));
    expect(keys.size).toBe(2);
    expect(report.regressedCount).toBe(0);
  });

  it("reports added pairs (only in current run)", () => {
    const prev: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
    ];
    const cur: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc2-new", result: "passed" }),
    ];
    const report = computeSuiteRegression(cur, prev, 10);
    expect(report.addedPairs).toHaveLength(1);
    expect(report.addedPairs[0].testCaseId).toBe("tc2-new");
  });

  it("reports removed pairs (only in prior run)", () => {
    const prev: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
      makeIteration({ testCaseId: "tc-gone", result: "passed" }),
    ];
    const cur: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
    ];
    const report = computeSuiteRegression(cur, prev, 10);
    expect(report.removedPairs).toHaveLength(1);
    expect(report.removedPairs[0].testCaseId).toBe("tc-gone");
  });

  it("ignores non-completed iterations defensively", () => {
    const prev: EvalIteration[] = [
      makeIteration({ testCaseId: "tc1", result: "passed" }),
    ];
    const cur: EvalIteration[] = [
      makeIteration({
        testCaseId: "tc1",
        result: "pending",
        status: "running",
      }),
      makeIteration({ testCaseId: "tc1", result: "passed" }),
    ];
    const report = computeSuiteRegression(cur, prev, 10);
    expect(report.comparable).toHaveLength(1);
    expect(report.comparable[0].currentTotal).toBe(1);
  });

  it("handles empty input", () => {
    const report = computeSuiteRegression([], [], 10);
    expect(report.comparable).toEqual([]);
    expect(report.addedPairs).toEqual([]);
    expect(report.removedPairs).toEqual([]);
    expect(report.regressedCount).toBe(0);
  });
});

describe("executionConfigKeyForIteration", () => {
  it("differs between two iterations whose snapshots differ by provider", () => {
    const a = makeIteration({
      testCaseId: "tc1",
      result: "passed",
      provider: "anthropic",
      model: "claude-haiku",
    });
    const b = makeIteration({
      testCaseId: "tc1",
      result: "passed",
      provider: "openai",
      model: "claude-haiku",
    });
    expect(executionConfigKeyForIteration(a)).not.toBe(
      executionConfigKeyForIteration(b),
    );
  });

  it("uses backend hostConfigId when present", () => {
    const a = makeIteration({
      testCaseId: "tc1",
      result: "passed",
      provider: "anthropic",
      model: "x",
    });
    const b = makeIteration({
      testCaseId: "tc1",
      result: "passed",
      provider: "anthropic",
      model: "y", // different model would normally yield different key
    });
    const keyA = executionConfigKeyForIteration({
      ...a,
      hostConfigId: "hc_pinned",
    });
    const keyB = executionConfigKeyForIteration({
      ...b,
      hostConfigId: "hc_pinned",
    });
    // Same hostConfigId + same provider = same key regardless of model.
    expect(keyA).toBe(keyB);
  });
});
