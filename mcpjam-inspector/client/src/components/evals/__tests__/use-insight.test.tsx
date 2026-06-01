import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
}));

import { useInsight } from "../use-insight";
import type { EvalSuiteRun } from "../types";

type GoalRun = EvalSuiteRun & {
  goalCompletionStatus?: "pending" | "completed" | "failed";
  goalCompletion?: { summary: string; generatedAt: number };
};

function makeRun(over: Partial<GoalRun> = {}): GoalRun {
  return {
    _id: "run-1",
    suiteId: "s",
    createdBy: "u",
    runNumber: 1,
    configRevision: "r",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    ...over,
  } as GoalRun;
}

const config = {
  getStatus: (r: EvalSuiteRun) => (r as GoalRun).goalCompletionStatus,
  getResult: (r: EvalSuiteRun) => (r as GoalRun).goalCompletion,
  requestMutation: "goalCompletion:requestGoalCompletion",
  cancelMutation: "goalCompletion:cancelGoalCompletion",
};

describe("useInsight requested lifecycle", () => {
  it("keeps `requested` across the re-run gap, then clears when a fresh result lands", () => {
    const prior = {
      goalCompletionStatus: "completed" as const,
      goalCompletion: { summary: "x", generatedAt: 100 },
    };
    const { result, rerender } = renderHook(
      ({ run }) => useInsight(run, config, { autoRequest: false }),
      { initialProps: { run: makeRun(prior) } },
    );

    expect(result.current.requested).toBe(false);

    act(() => result.current.requestInsight(true));
    expect(result.current.requested).toBe(true);

    // Stale "completed" still present (same generatedAt) — must NOT clear, or a
    // second click could fire a duplicate judge call in the click→pending gap.
    rerender({ run: makeRun(prior) });
    expect(result.current.requested).toBe(true);

    // A fresh result lands (generatedAt advanced) even without an observed
    // `pending` frame — the controls must not stay stuck disabled.
    rerender({
      run: makeRun({
        goalCompletionStatus: "completed",
        goalCompletion: { summary: "y", generatedAt: 200 },
      }),
    });
    expect(result.current.requested).toBe(false);
  });

  it("clears `requested` once the job starts (status flips to pending)", () => {
    const { result, rerender } = renderHook(
      ({ run }) => useInsight(run, config, { autoRequest: false }),
      { initialProps: { run: makeRun({ goalCompletionStatus: undefined }) } },
    );

    act(() => result.current.requestInsight(false));
    expect(result.current.requested).toBe(true);

    rerender({ run: makeRun({ goalCompletionStatus: "pending" }) });
    expect(result.current.requested).toBe(false);
  });
});
