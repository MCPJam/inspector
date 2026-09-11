/**
 * BB-196: analysis and clustering run on their own.
 *
 * What these pin is the discipline around that, not the queueing itself — the
 * mutation is one line. A hook that starts paid work on mount is one bad
 * dependency away from starting it on every keystroke, so:
 *
 *   - ONE START PER COHORT, however many times the breakdown updates. A
 *     clustering pass costs embeddings plus an LLM pass; two of them over
 *     nearly the same window is money for nothing.
 *   - FROM A STANDING START ONLY. An analysis that exists is never refreshed
 *     here. Staleness is the backend's to judge, on a clock that knows when a
 *     session's outcome became assertable; a mount knows nothing about that.
 *   - LOADING IS NOT AN ANSWER. Acting on the first, undefined subscription
 *     would analyze every cohort the user merely passes through.
 *   - ABSENT IS NOT ZERO. A backend that does not report a session count is
 *     not a cohort with no sessions.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEnsureFirstAnalysis } from "../useInsightsFlowController";
import type { UsageBreakdown } from "../useUsageInsights";

/** Only the three fields the hook reads; the rest never reaches it. */
function breakdown(
  overrides: Partial<Pick<UsageBreakdown, "totalSessions" | "latestRun">> = {},
): UsageBreakdown {
  return {
    totalSessions: 4,
    latestRun: null,
    ...overrides,
  } as unknown as UsageBreakdown;
}

const queued = { runId: "run-1", status: "queued", alreadyRunning: false };

function setup(
  initial: {
    enabled?: boolean;
    cohortKey?: string;
    breakdown?: UsageBreakdown | null | undefined;
  } = {},
) {
  const rebuild = vi.fn().mockResolvedValue(queued);
  const props = {
    enabled: initial.enabled ?? true,
    cohortKey: initial.cohortKey ?? "scenario-1",
    breakdown: "breakdown" in initial ? initial.breakdown : breakdown(),
    rebuild,
  };
  const view = renderHook((p: typeof props) => useEnsureFirstAnalysis(p), {
    initialProps: props,
  });
  return { rebuild, view, props };
}

/** The failure the signed-out-guest path produces: a refused mutation. */
const REFUSED = new Error("Not authenticated");

describe("useEnsureFirstAnalysis", () => {
  it("starts the analysis a cohort with sessions has never had", async () => {
    const { rebuild } = setup();
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    // No arguments: the surface is not choosing tuning on the user's behalf.
    expect(rebuild.mock.calls[0]).toEqual([]);
  });

  it("starts it once however many times the breakdown updates", async () => {
    const { rebuild, view, props } = setup();
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));

    // A fresh object identity each time, as a Convex subscription delivers.
    view.rerender({ ...props, breakdown: breakdown() });
    view.rerender({ ...props, breakdown: breakdown({ totalSessions: 5 }) });
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("leaves an analysis that already exists alone", () => {
    const { rebuild } = setup({
      breakdown: breakdown({
        latestRun: { status: "done" } as UsageBreakdown["latestRun"],
      }),
    });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("waits for the breakdown rather than acting on a loading subscription", async () => {
    const { rebuild, view, props } = setup({ breakdown: undefined });
    expect(rebuild).not.toHaveBeenCalled();

    view.rerender({ ...props, breakdown: breakdown() });
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
  });

  it("does nothing for a cohort with no sessions", () => {
    const { rebuild } = setup({ breakdown: breakdown({ totalSessions: 0 }) });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("treats a missing session count as unknown rather than empty", async () => {
    const { rebuild } = setup({
      breakdown: breakdown({ totalSessions: undefined }),
    });
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
  });

  it("stays out of the way on a surface that waits to be asked", () => {
    const { rebuild } = setup({ enabled: false });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("arms again for a different cohort", async () => {
    const { rebuild, view, props } = setup();
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));

    view.rerender({ ...props, cohortKey: "scenario-2" });
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
  });

  it("reports a refused start, with no further subscription update needed", async () => {
    // The regression this pins: a rejection used to only clear a ref, which
    // re-runs nothing. The caller was left promising an analysis that was
    // never coming, and the diagram hides its rebuild button while it thinks
    // one is on the way.
    const rebuild = vi.fn().mockRejectedValue(REFUSED);
    const props = {
      enabled: true,
      cohortKey: "scenario-1",
      breakdown: breakdown(),
      rebuild,
    };
    const view = renderHook((p: typeof props) => useEnsureFirstAnalysis(p), {
      initialProps: props,
    });

    await waitFor(() => expect(view.result.current.failed).toBe(true));
    // Nothing about the inputs changed — the failure surfaced on its own.
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("does not keep retrying a start that was refused", async () => {
    // `rebuildScenarioInsights` authenticates, so a signed-out guest is
    // refused every time. Re-attempting on each breakdown push would spend
    // attempts to arrive at the same place; the recovery is the button.
    const rebuild = vi.fn().mockRejectedValue(REFUSED);
    const props = {
      enabled: true,
      cohortKey: "scenario-1",
      breakdown: breakdown(),
      rebuild,
    };
    const view = renderHook((p: typeof props) => useEnsureFirstAnalysis(p), {
      initialProps: props,
    });
    await waitFor(() => expect(view.result.current.failed).toBe(true));

    view.rerender({ ...props, breakdown: breakdown() });
    view.rerender({ ...props, breakdown: breakdown({ totalSessions: 9 }) });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(view.result.current.failed).toBe(true);
  });

  it("does not re-attempt a refused cohort when the user returns to it", async () => {
    // The single-key latch could only remember the LAST cohort. Go to a
    // refused scenario, leave, come back, and the guard passed again — so the
    // hook re-queued in the background while `failed` was still presenting the
    // manual button that says it will not.
    const rebuild = vi.fn().mockRejectedValue(REFUSED);
    const props = {
      enabled: true,
      cohortKey: "scenario-1",
      breakdown: breakdown(),
      rebuild,
    };
    const view = renderHook((p: typeof props) => useEnsureFirstAnalysis(p), {
      initialProps: props,
    });
    await waitFor(() => expect(view.result.current.failed).toBe(true));

    view.rerender({ ...props, cohortKey: "scenario-2" });
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));

    view.rerender({ ...props, cohortKey: "scenario-1" });
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(view.result.current.failed).toBe(true);
  });

  it("does not carry one cohort's refusal over to the next", async () => {
    const rebuild = vi
      .fn()
      .mockRejectedValueOnce(REFUSED)
      .mockResolvedValue(queued);
    const props = {
      enabled: true,
      cohortKey: "scenario-1",
      breakdown: breakdown(),
      rebuild,
    };
    const view = renderHook((p: typeof props) => useEnsureFirstAnalysis(p), {
      initialProps: props,
    });
    await waitFor(() => expect(view.result.current.failed).toBe(true));

    // A different scenario is a clean slate: its analysis has not been refused.
    view.rerender({ ...props, cohortKey: "scenario-2" });
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
    expect(view.result.current.failed).toBe(false);
  });

  it("reports no failure on a start that succeeded", async () => {
    const { rebuild, view } = setup();
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(view.result.current.failed).toBe(false);
  });
});
