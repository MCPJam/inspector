import { describe, expect, it } from "vitest";
import {
  formatRunCaseLatencyMs,
  groupRunIterationsByTestCase,
} from "../run-case-groups";
import type { EvalIteration } from "../types";

function makeIteration(
  overrides: Partial<EvalIteration> & {
    testCaseId?: string;
    title?: string;
    durationMs?: number;
    passed?: boolean;
  },
): EvalIteration {
  const {
    title = "Test A",
    durationMs = 1000,
    passed = true,
    testCaseId = "tc-1",
    ...rest
  } = overrides;

  return {
    _id: rest._id ?? `iter-${Math.random()}`,
    testCaseId,
    suiteRunId: "run-1",
    status: "completed",
    result: passed ? "passed" : "failed",
    resultSource: "reported",
    createdAt: 0,
    startedAt: 0,
    updatedAt: durationMs,
    testCaseSnapshot: {
      title,
      query: "q",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [],
    },
    ...rest,
  } as EvalIteration;
}

describe("groupRunIterationsByTestCase", () => {
  it("groups multiple iterations of the same test case", () => {
    const iterations = [
      makeIteration({ _id: "i1", passed: true, durationMs: 1000 }),
      makeIteration({ _id: "i2", passed: false, durationMs: 2000 }),
      makeIteration({ _id: "i3", passed: true, durationMs: 3000 }),
    ];

    const groups = groupRunIterationsByTestCase(iterations, "test");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.total).toBe(3);
    expect(groups[0]?.passed).toBe(2);
    expect(groups[0]?.failed).toBe(1);
    expect(groups[0]?.iterationResults).toEqual(["pass", "fail", "pass"]);
  });

  it("computes p50 and p95 latency per group", () => {
    const iterations = [
      makeIteration({ _id: "i1", durationMs: 1000 }),
      makeIteration({ _id: "i2", durationMs: 2000 }),
      makeIteration({ _id: "i3", durationMs: 3000 }),
      makeIteration({ _id: "i4", durationMs: 4000 }),
    ];

    const [group] = groupRunIterationsByTestCase(iterations, "test");
    expect(group?.p50Ms).toBe(2500);
    expect(group?.p95Ms).toBeCloseTo(3850, 0);
  });

  it("sorts failing groups first when sortBy is result", () => {
    const iterations = [
      makeIteration({
        _id: "i1",
        testCaseId: "tc-pass",
        title: "Always passes",
        passed: true,
      }),
      makeIteration({
        _id: "i2",
        testCaseId: "tc-fail",
        title: "Has failure",
        passed: false,
      }),
    ];

    const groups = groupRunIterationsByTestCase(iterations, "result");
    expect(groups[0]?.title).toBe("Has failure");
  });
});

describe("formatRunCaseLatencyMs", () => {
  it("formats sub-second and second values", () => {
    expect(formatRunCaseLatencyMs(null)).toBe("—");
    expect(formatRunCaseLatencyMs(500)).toBe("500ms");
    expect(formatRunCaseLatencyMs(1500)).toBe("1.5s");
    expect(formatRunCaseLatencyMs(12000)).toBe("12s");
  });
});
