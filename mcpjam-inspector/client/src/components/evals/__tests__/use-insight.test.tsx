import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { requestMutationMock } = vi.hoisted(() => ({
  requestMutationMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: () => requestMutationMock,
}));

beforeEach(() => {
  requestMutationMock.mockReset();
  requestMutationMock.mockResolvedValue(undefined);
});

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

  it("clears `requested` when a re-run ends in failure (fresh fallback result)", () => {
    const prior = {
      goalCompletionStatus: "completed" as const,
      goalCompletion: { summary: "x", generatedAt: 100 },
    };
    const { result, rerender } = renderHook(
      ({ run }) => useInsight(run, config, { autoRequest: false }),
      { initialProps: { run: makeRun(prior) } },
    );

    act(() => result.current.requestInsight(true));
    expect(result.current.requested).toBe(true);

    // The judge job fails: the backend writes a fresh failed fallback (new
    // generatedAt) alongside status "failed", so the controls must re-enable.
    rerender({
      run: makeRun({
        goalCompletionStatus: "failed",
        goalCompletion: { summary: "failed fallback", generatedAt: 200 },
      }),
    });
    expect(result.current.requested).toBe(false);
    expect(result.current.failedGeneration).toBe(true);
  });

  it("resets `unavailable` when the run changes", async () => {
    // A run-specific failure (the backend throws "Suite run not found") matches
    // the unavailable heuristic; it must not keep the panel hidden for later
    // runs viewed in the same mounted hook.
    requestMutationMock.mockRejectedValueOnce(new Error("Suite run not found"));
    const { result, rerender } = renderHook(
      ({ run }) => useInsight(run, config, { autoRequest: false }),
      { initialProps: { run: makeRun({ _id: "run-1" }) } },
    );

    await act(async () => {
      result.current.requestInsight(false);
      await Promise.resolve();
    });
    expect(result.current.unavailable).toBe(true);

    rerender({ run: makeRun({ _id: "run-2" }) });
    expect(result.current.unavailable).toBe(false);
  });

  it("keeps `unavailable` sticky across runs when the backend feature is missing", async () => {
    // A genuine "feature missing" failure (mutation not deployed) is permanent
    // for the session; resetting it on every run switch would re-fire a failing
    // (auto)request and flash the panel. It must stay hidden.
    requestMutationMock.mockRejectedValue(
      new Error("Could not find public function for 'goalCompletion:x'"),
    );
    const { result, rerender } = renderHook(
      ({ run }) => useInsight(run, config, { autoRequest: false }),
      { initialProps: { run: makeRun({ _id: "run-1" }) } },
    );

    await act(async () => {
      result.current.requestInsight(false);
      await Promise.resolve();
    });
    expect(result.current.unavailable).toBe(true);

    rerender({ run: makeRun({ _id: "run-2" }) });
    expect(result.current.unavailable).toBe(true);
  });
});
