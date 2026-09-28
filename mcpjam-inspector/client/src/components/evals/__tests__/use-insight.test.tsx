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

describe("useInsight sign-in refusals", () => {
  it("reports the refusal as a sign-in prompt, not as an unavailable feature", async () => {
    // The generic branch below this one matches `Server Error`, which Convex
    // prefixes onto every thrown mutation error. Classifying a guest refusal
    // there sets `unavailable`, and `SuiteInsightsCollapsible` renders null on
    // unavailable — so the trial user who just ran their first suite would see
    // no insights band at all, with no way to learn why.
    requestMutationMock.mockRejectedValue(
      new Error(
        '[CONVEX M(runInsights:requestRunInsights)] Server Error ' +
          '{"code":"sign_in_required","feature":"run insights",' +
          '"message":"Sign in to keep going."}',
      ),
    );

    const { result } = renderHook(() =>
      useInsight(makeRun({ _id: "run-guest" }), config),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.signInRequired).toBe(true);
    expect(result.current.unavailable).toBe(false);
    // The backend's own copy reaches the banner verbatim.
    expect(result.current.errorMessage).toBe("Sign in to keep going.");
  });

  it("stops auto-requesting on later runs once a guest has been refused", async () => {
    // `hasAutoAttemptedRef` is per-run and the run-change effect clears it, so
    // without a sticky latch a guest opening run after run fires one doomed
    // request each time. Who is asking does not change by navigating.
    requestMutationMock.mockRejectedValue(
      new Error(
        'Server Error {"code":"sign_in_required","message":"Sign in to keep going."}',
      ),
    );

    const { rerender } = renderHook(
      ({ run }: { run: GoalRun }) => useInsight(run, config),
      { initialProps: { run: makeRun({ _id: "run-a" }) } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(1);

    rerender({ run: makeRun({ _id: "run-b" }) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(1);
  });

  it("an explicit press asks again — the viewer may have signed in since", async () => {
    requestMutationMock.mockRejectedValue(
      new Error('Server Error {"code":"sign_in_required","message":"Sign in."}'),
    );
    const { result } = renderHook(() =>
      useInsight(makeRun({ _id: "run-press" }), config),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.requestInsight(true);
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(2);
  });

  it("does not show run A's refusal on run B", async () => {
    // A rejection is not instant. Navigate inside that window and the catch
    // still owns this hook's state: without a guard it writes run A's verdict
    // over the run the viewer is now looking at, and the sign-in call to
    // action appears on a run that was never refused.
    let rejectFirst: (err: unknown) => void = () => {};
    requestMutationMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    requestMutationMock.mockResolvedValue(undefined);

    const { result, rerender } = renderHook(
      ({ run }: { run: GoalRun }) => useInsight(run, config),
      { initialProps: { run: makeRun({ _id: "run-a" }) } },
    );

    rerender({ run: makeRun({ _id: "run-b" }) });
    await act(async () => {
      rejectFirst(
        new Error(
          'Server Error {"code":"sign_in_required","message":"Sign in to keep going."}',
        ),
      );
      await Promise.resolve();
    });

    expect(result.current.signInRequired).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it("still latches on a stale refusal — navigating does not change who is asking", async () => {
    // The other half of the guard above, and the reason it is scoped to
    // VISIBLE state only. The refusal was late, not wrong: a guest is still a
    // guest on run B, so the latch must survive even though the banner does
    // not. Losing it here would restore the doomed request per run that the
    // latch exists to stop.
    let rejectFirst: (err: unknown) => void = () => {};
    requestMutationMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    requestMutationMock.mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ run }: { run: GoalRun }) => useInsight(run, config),
      { initialProps: { run: makeRun({ _id: "run-a" }) } },
    );
    expect(requestMutationMock).toHaveBeenCalledTimes(1);

    rerender({ run: makeRun({ _id: "run-b" }) });
    await act(async () => {
      rejectFirst(
        new Error(
          'Server Error {"code":"sign_in_required","message":"Sign in."}',
        ),
      );
      await Promise.resolve();
    });

    // run-b auto-requested before the refusal landed; run-c must not.
    const afterB = requestMutationMock.mock.calls.length;
    rerender({ run: makeRun({ _id: "run-c" }) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(afterB);
  });

  it("an in-flight refusal cannot re-latch after an explicit press cleared it", async () => {
    // The press is the newer claim: it means the viewer may have signed in
    // since. A request that was already in flight rejects AFTER it and would
    // otherwise set the latch straight back, suppressing auto-requests for the
    // rest of the session for someone who has just signed in.
    let rejectFirst: (err: unknown) => void = () => {};
    requestMutationMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    requestMutationMock.mockResolvedValue(undefined);

    const { result, rerender } = renderHook(
      ({ run }: { run: GoalRun }) => useInsight(run, config),
      { initialProps: { run: makeRun({ _id: "run-a" }) } },
    );
    expect(requestMutationMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.requestInsight(true);
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      rejectFirst(
        new Error(
          'Server Error {"code":"sign_in_required","message":"Sign in."}',
        ),
      );
      await Promise.resolve();
    });

    // The latch is clear, so a later run auto-requests as it would for anyone.
    rerender({ run: makeRun({ _id: "run-b" }) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the refusal VISIBLE on the next run while requests stay suppressed", async () => {
    // The other half of the sticky latch, and the half that was missing. The
    // latch correctly stopped run B from firing a doomed request — and the
    // run-change reset cleared `signInRequired` and the message on the way, so
    // run B showed requests suppressed and nothing explaining why: no copy, no
    // Sign in control, and `SuiteInsightsCollapsible` falling through to "Open a
    // completed run…" with one already open.
    //
    // The suppression and its remedy are the same fact about identity, so they
    // travel together. Fixing this by re-enabling the request per run would
    // reintroduce the doomed-request-per-run bug the latch exists to stop,
    // which is why the mutation count is asserted too.
    requestMutationMock.mockRejectedValue(
      new Error(
        'Server Error {"code":"SIGN_IN_REQUIRED","message":"Sign in to keep going."}',
      ),
    );

    const { result, rerender } = renderHook(
      ({ run }: { run: GoalRun }) => useInsight(run, config),
      { initialProps: { run: makeRun({ _id: "run-a" }) } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.signInRequired).toBe(true);
    expect(requestMutationMock).toHaveBeenCalledTimes(1);

    rerender({ run: makeRun({ _id: "run-b" }) });
    await act(async () => {
      await Promise.resolve();
    });

    // Still suppressed…
    expect(requestMutationMock).toHaveBeenCalledTimes(1);
    // …and still SAYING SO.
    expect(result.current.signInRequired).toBe(true);
    expect(result.current.errorMessage).toBe("Sign in to keep going.");
  });

  it("an earlier attempt on the SAME run cannot answer for a newer one", async () => {
    // The run guard alone was not enough: it compared runs, and both attempts
    // here belong to one run. A late rejection from the superseded attempt
    // therefore set `signInRequired`, restored its stale message, and cleared
    // the `requested` flag the newer in-flight attempt had set.
    let rejectFirst: (err: unknown) => void = () => {};
    requestMutationMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    requestMutationMock.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useInsight(makeRun({ _id: "run-same" }), config),
    );
    expect(requestMutationMock).toHaveBeenCalledTimes(1);

    // A press supersedes the in-flight auto-request, and this one succeeds.
    await act(async () => {
      result.current.requestInsight(true);
      await Promise.resolve();
    });
    expect(requestMutationMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      rejectFirst(
        new Error(
          'Server Error {"code":"SIGN_IN_REQUIRED","message":"Stale refusal."}',
        ),
      );
      await Promise.resolve();
    });

    // The newer attempt owns the surface.
    expect(result.current.signInRequired).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it("leaves an undeployed backend classified as unavailable", async () => {
    // The negative half: `sign_in_required` must not swallow the case the
    // `unavailable` latch exists for. A missing function is permanent for the
    // session; who is asking is not.
    requestMutationMock.mockRejectedValue(
      new Error("Could not find public function for 'runInsights'"),
    );

    const { result } = renderHook(() =>
      useInsight(makeRun({ _id: "run-missing" }), config),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.unavailable).toBe(true);
    expect(result.current.signInRequired).toBe(false);
  });
});
