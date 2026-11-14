/**
 * The per-run chain read's gating and its walk.
 *
 * The assertions that matter are the ones about SILENCE: with the caller's
 * switch off, no project, or a run that has not finished, this must issue no
 * request at all — that is what keeps every non-Evaluate mount of the views
 * downstream at exactly zero reads.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchChains = vi.fn();
vi.mock("@/lib/apis/eval-run-iterations-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/eval-run-iterations-api")
  >("@/lib/apis/eval-run-iterations-api");
  return {
    ...actual,
    fetchEvalRunIterationChains: (...args: unknown[]) => fetchChains(...args),
  };
});

import { useEvalRunIterationChains } from "../use-eval-run-iteration-chains";

const terminalRun = {
  _id: "run_1",
  status: "completed",
  result: "failed",
  completedAt: 1_700_000_000_000,
};

function chainPage(ids: string[], nextCursor?: string) {
  return {
    items: ids.map((id) => ({
      iterationId: id,
      chain: { status: "verified", stages: [], analyzerVersion: 8 },
    })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

beforeEach(() => {
  fetchChains.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("useEvalRunIterationChains", () => {
  it("reads a terminal run's chains and keys them by iteration", async () => {
    fetchChains.mockResolvedValue(chainPage(["iter_1", "iter_2"]));

    const { result } = renderHook(() =>
      useEvalRunIterationChains({
        projectId: "proj_1",
        run: terminalRun,
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.chains.get("iter_1")?.status).toBe("verified");
    expect(result.current.chains.size).toBe(2);
    expect(result.current.walkExhausted).toBe(true);
  });

  it.each([
    ["the caller's switch is off", { enabled: false, projectId: "proj_1" }],
    ["there is no project", { enabled: true, projectId: null }],
  ])("issues NO request when %s", async (_label, target) => {
    renderHook(() =>
      useEvalRunIterationChains({
        projectId: target.projectId,
        run: terminalRun,
        enabled: target.enabled,
      }),
    );

    await Promise.resolve();
    expect(fetchChains).not.toHaveBeenCalled();
  });

  it("never reports the previous run's chains on the render that switches runs", async () => {
    fetchChains.mockResolvedValueOnce(chainPage(["iter_1", "iter_2"]));
    // The second run's read never resolves: everything after the switch is
    // the in-flight window.
    fetchChains.mockReturnValueOnce(new Promise(() => {}));
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ run }) => {
        const state = useEvalRunIterationChains({
          projectId: "proj_1",
          run,
          enabled: true,
        });
        seen.push(`${run._id}:${state.status}:${state.chains.size}`);
        return state;
      },
      { initialProps: { run: terminalRun } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const switchedAt = seen.length;
    rerender({ run: { ...terminalRun, _id: "run_2" } });

    const afterSwitch = seen.slice(switchedAt);
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch.every((entry) => entry === "run_2:loading:0")).toBe(
      true,
    );
  });

  it("reads the same run again on retry after a failed read", async () => {
    fetchChains.mockRejectedValueOnce(new Error("boom"));
    fetchChains.mockResolvedValueOnce(chainPage(["iter_1"]));
    const { result } = renderHook(() =>
      useEvalRunIterationChains({
        projectId: "proj_1",
        run: terminalRun,
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));

    act(() => result.current.retry?.());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchChains).toHaveBeenCalledTimes(2);
    expect(result.current.chains.get("iter_1")?.status).toBe("verified");
  });

  it("issues no request while the run is still going", async () => {
    renderHook(() =>
      useEvalRunIterationChains({
        projectId: "proj_1",
        run: { ...terminalRun, status: "running" },
        enabled: true,
      }),
    );

    await Promise.resolve();
    expect(fetchChains).not.toHaveBeenCalled();
  });

  it("re-reads when a late judge changes the run's revision", async () => {
    fetchChains.mockResolvedValue(chainPage(["iter_1"]));
    const { rerender } = renderHook(
      (props: { run: typeof terminalRun }) =>
        useEvalRunIterationChains({
          projectId: "proj_1",
          run: props.run,
          enabled: true,
        }),
      { initialProps: { run: terminalRun } },
    );
    await waitFor(() => expect(fetchChains).toHaveBeenCalledTimes(1));

    // A terminal run is not frozen: the verdict summary changing means the
    // cached chains describe an older reading.
    rerender({ run: { ...terminalRun, verdictSummary: { v: 2 } } as never });
    await waitFor(() => expect(fetchChains).toHaveBeenCalledTimes(2));
  });

  it("follows the cursor, and says so when it ran out of pages first", async () => {
    fetchChains.mockImplementation((params: { cursor?: string }) =>
      Promise.resolve(
        params.cursor
          ? chainPage(["iter_2"])
          : chainPage(["iter_1"], "cursor_2"),
      ),
    );

    const { result } = renderHook(() =>
      useEvalRunIterationChains({
        projectId: "proj_1",
        run: terminalRun,
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.chains.size).toBe(2);
    expect(result.current.walkExhausted).toBe(true);
  });

  it("reports a failed read without inventing empty chains", async () => {
    const { EvalRunIterationsError } = await vi.importActual<
      typeof import("@/lib/apis/eval-run-iterations-api")
    >("@/lib/apis/eval-run-iterations-api");
    fetchChains.mockRejectedValue(
      new EvalRunIterationsError("routeUnavailable", "nope"),
    );

    const { result } = renderHook(() =>
      useEvalRunIterationChains({
        projectId: "proj_1",
        run: terminalRun,
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("routeUnavailable");
    // An unreadable route is not a run whose trials have no chains.
    expect(result.current.chains.size).toBe(0);
  });
});
