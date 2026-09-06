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
  __resetAutoRequestClaims();
});

import { useInsight, __resetAutoRequestClaims } from "../use-insight";
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

describe("useInsight auto-request de-duplication (CONVEX-AR)", () => {
  it("fires ONCE when several components observe the same run", async () => {
    // The bug: three eval surfaces auto-request on first view. Each hook
    // instance had its own attempted-flag, so each one requested, and every
    // caller after the first was rejected with "already being generated".
    const run = makeRun({ _id: "run-shared" });

    const first = renderHook(() => useInsight(run, config));
    const second = renderHook(() => useInsight(run, config));
    const third = renderHook(() => useInsight(run, config));

    expect(requestMutationMock).toHaveBeenCalledTimes(1);
    expect(requestMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({ suiteRunId: "run-shared" }),
    );

    first.unmount();
    second.unmount();
    third.unmount();
  });

  it("scopes the claim per run, so a different run still auto-requests", () => {
    renderHook(() => useInsight(makeRun({ _id: "run-a" }), config));
    renderHook(() => useInsight(makeRun({ _id: "run-b" }), config));

    expect(requestMutationMock).toHaveBeenCalledTimes(2);
  });

  it("scopes the claim per mutation, so surfaces don't block each other", () => {
    const run = makeRun({ _id: "run-shared" });
    renderHook(() => useInsight(run, config));
    renderHook(() =>
      useInsight(run, {
        ...config,
        requestMutation: "serverQuality:requestServerQuality",
      }),
    );

    expect(requestMutationMock).toHaveBeenCalledTimes(2);
  });

  it("releases the claim when the request fails, so a remount can retry", async () => {
    // Otherwise one transient failure would disable first-view generation for
    // that run for the rest of the session.
    requestMutationMock.mockRejectedValueOnce(new Error("network blip"));
    const run = makeRun({ _id: "run-retry" });

    const first = renderHook(() => useInsight(run, config));
    await act(async () => {});
    first.unmount();

    requestMutationMock.mockResolvedValue(undefined);
    renderHook(() => useInsight(run, config));

    expect(requestMutationMock).toHaveBeenCalledTimes(2);
  });

  it("does not claim when auto-request is off", () => {
    const run = makeRun({ _id: "run-manual" });
    renderHook(() => useInsight(run, config, { autoRequest: false }));
    expect(requestMutationMock).not.toHaveBeenCalled();

    // The claim was never taken, so a surface that DOES auto-request still
    // gets its first-view generation.
    renderHook(() => useInsight(run, config));
    expect(requestMutationMock).toHaveBeenCalledTimes(1);
  });

  it("a null run claims nothing, and the run it receives later still fires", () => {
    // The hook's run is nullable at every real call site — the test-case
    // detail passes `pickLatestCompletedRun(runs)`, null until the suite's runs
    // load, and the insights band passes a `targetRun` that resolves to null
    // when no run is selected yet. Keying the claim off a run id means a null
    // render must not burn the claim of the run that arrives after it, or the
    // surfaces that mount before their data would never auto-request at all.
    const { rerender } = renderHook(
      ({ run }: { run: GoalRun | null }) => useInsight(run, config),
      { initialProps: { run: null as GoalRun | null } },
    );

    expect(requestMutationMock).not.toHaveBeenCalled();

    rerender({ run: makeRun({ _id: "run-after-null" }) });

    expect(requestMutationMock).toHaveBeenCalledTimes(1);
    expect(requestMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({ suiteRunId: "run-after-null" }),
    );
  });
});

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
