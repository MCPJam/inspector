import { describe, expect, test, vi } from "vitest";

// The matcher is spied at the module boundary, so "was it invoked?" is a fact
// about the call graph rather than about a value that happened to agree. That
// is the whole assertion here: a row with a stored result must not be RE-GRADED
// in the browser, and a test that only compared verdicts would pass just as
// happily while the second grader ran and agreed by luck.
const evaluateToolCalls = vi.fn(() => ({
  passed: true,
  missing: [],
  extra: [],
  unexpected: [],
  outOfOrder: [],
  argumentMismatches: [],
  matched: [],
}));

vi.mock("@/shared/eval-matching", async () => {
  const actual = await vi.importActual<typeof import("@/shared/eval-matching")>(
    "@/shared/eval-matching"
  );
  return { ...actual, evaluateToolCalls };
});

const { computeIterationPassed, computeIterationResult } = await import(
  "../pass-criteria"
);

// =============================================================================
// B3b W4 — the retirement pin.
//
// What retires is the browser's UNVERIFIED RE-DERIVATION of an iteration that
// has already been graded. What survives is the matcher itself, for rows that
// carry no stored result: legacy history, and the live-grading preview whose
// synthetic per-turn rows were never persisted at all.
//
// After this ships, restoring the old behaviour means reverting the PR that
// introduced it — there is no flag.
// =============================================================================

/** A row that was graded server-side, whose tool calls DISAGREE with the verdict. */
function storedRow(result: "passed" | "failed", resultSource?: string) {
  return {
    _id: "iter1",
    result,
    ...(resultSource ? { resultSource } : {}),
    status: "completed",
    // Deliberately contradictory evidence: the matcher, if it ran, would say
    // "passed" (see the stub above) regardless of what the server decided.
    actualToolCalls: [],
    testCaseSnapshot: { expectedToolCalls: [{ toolName: "x", arguments: {} }] },
  } as never;
}

describe("a stored result is the only source for a row that has one", () => {
  test.each(["reported", "derived", undefined] as const)(
    "resultSource %s — the matcher is never invoked",
    (resultSource) => {
      evaluateToolCalls.mockClear();
      expect(computeIterationPassed(storedRow("failed", resultSource))).toBe(
        false
      );
      // `derived` is the case that changed. Before W4 only `reported`
      // short-circuited, so a derived row was re-graded in the browser from
      // `actualToolCalls` alone — blind to predicates, gates and tool errors,
      // which at `enforce` are most of what decided the verdict.
      expect(evaluateToolCalls).not.toHaveBeenCalled();
    }
  );

  test("a stored pass is a pass even when the tool calls do not match", () => {
    evaluateToolCalls.mockClear();
    expect(computeIterationPassed(storedRow("passed", "derived"))).toBe(true);
    expect(evaluateToolCalls).not.toHaveBeenCalled();
  });

  test("computeIterationResult agrees, through the same rule", () => {
    expect(computeIterationResult(storedRow("failed", "derived"))).toBe(
      "failed"
    );
  });
});

describe("the matcher survives where there is nothing stored to trust", () => {
  test("a legacy row with no result is still graded by the matcher", () => {
    evaluateToolCalls.mockClear();
    // Falling back to "not passed" here would silently re-grade years of
    // history as failures, which is why absence keeps the old path rather than
    // taking the new one's default.
    const legacy = {
      _id: "legacy",
      status: "completed",
      actualToolCalls: [{ toolName: "x", arguments: {} }],
      testCaseSnapshot: {
        expectedToolCalls: [{ toolName: "x", arguments: {} }],
      },
    } as never;

    expect(computeIterationPassed(legacy)).toBe(true);
    expect(evaluateToolCalls).toHaveBeenCalledTimes(1);
  });

  test("a live-grading style projection is still graded by the matcher", () => {
    evaluateToolCalls.mockClear();
    // `eval-live-grading.ts` builds these per user turn. They are a PREVIEW of
    // a verdict, not a re-derivation of a decided one, so they were never
    // persisted and have no stored result to defer to.
    const preview = {
      status: "completed",
      actualToolCalls: [{ toolName: "search", arguments: {} }],
      testCaseSnapshot: {
        expectedToolCalls: [{ toolName: "search", arguments: {} }],
      },
    } as never;

    expect(computeIterationPassed(preview)).toBe(true);
    expect(evaluateToolCalls).toHaveBeenCalledTimes(1);
  });
});
