/**
 * The run-scoped stage-analytics fetch hook (UVH-IN6).
 *
 * Two claims worth pinning, and they are the ones the suite hook cannot make:
 *
 *   - A 404 is an ANSWER. The API returns the same one for "this run has no
 *     document" and "this run is not visible to you", so an error state here
 *     would put a red service message on every run that finished before the
 *     materializer shipped — which is most of them.
 *   - A late response for the PREVIOUS run must never land under the current
 *     run's heading. The run detail reuses one view across runs, so this is a
 *     real sequence, not a hypothetical.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useEvalRunStageAnalytics } from "../use-eval-run-stage-analytics";
import type { EvalRunStageAnalyticsState } from "../use-eval-run-stage-analytics";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";
import { EvalStageAnalyticsError } from "@/lib/apis/eval-stage-analytics-api";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/apis/eval-stage-analytics-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/eval-stage-analytics-api")
  >("@/lib/apis/eval-stage-analytics-api");
  return { ...actual, fetchEvalRunStageAnalytics: fetchMock };
});

const RUN_ID = GOLDEN_STAGE_ANALYTICS.runId;

function Harness({
  projectId = "p1",
  runId = RUN_ID,
  runStatus,
  enabled = true,
  onState,
}: {
  projectId?: string | null;
  runId?: string | null;
  runStatus?: string | null;
  enabled?: boolean;
  onState: (state: EvalRunStageAnalyticsState) => void;
}) {
  onState(useEvalRunStageAnalytics({ projectId, runId, runStatus, enabled }));
  return null;
}

function renderHook(props: Partial<Parameters<typeof Harness>[0]> = {}) {
  const states: EvalRunStageAnalyticsState[] = [];
  const utils = render(
    <Harness {...props} onState={(state) => states.push(state)} />,
  );
  return {
    ...utils,
    states,
    latest: () => states[states.length - 1]!,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useEvalRunStageAnalytics", () => {
  it("reads the run and reports ready with its document", async () => {
    fetchMock.mockResolvedValue(GOLDEN_STAGE_ANALYTICS);

    const { latest } = renderHook();
    await waitFor(() => expect(latest().status).toBe("ready"));

    expect(latest().document).toEqual(GOLDEN_STAGE_ANALYTICS);
    expect(latest().error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      { projectId: "p1", runId: RUN_ID },
      expect.any(AbortSignal),
    );
  });

  it("reports a 404 as ABSENT, not as an error", async () => {
    // The state most runs are in. `absent` renders as "unmeasured"; `error`
    // would render as "something is broken", on a run where nothing is.
    fetchMock.mockRejectedValue(
      new EvalStageAnalyticsError(
        "notFound",
        "This run has no stage analytics",
        {
          status: 404,
        },
      ),
    );

    const { latest } = renderHook();
    await waitFor(() => expect(latest().status).toBe("absent"));

    expect(latest().document).toBeNull();
    // No error object either: a caller that renders `error` when present must
    // not find one here.
    expect(latest().error).toBeNull();
  });

  it("keeps the other three failure kinds APART, as errors", async () => {
    for (const kind of [
      "routeUnavailable",
      "requestFailed",
      "invalidContract",
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new EvalStageAnalyticsError(kind, "no"));
      const { latest, unmount } = renderHook();
      await waitFor(() => expect(latest().status).toBe("error"));
      // The KIND survives to the caller: the slot renders the dark-ship window
      // silently and a real failure out loud, and it cannot tell them apart
      // from a flattened message.
      expect(latest().error?.kind).toBe(kind);
      unmount();
    }
  });

  it("never lets a late response for the PREVIOUS run paint over the current one", async () => {
    // The run selector reuses one view. Without the request-id guard, run 1's
    // slow answer would land after run 2's and be rendered under run 2.
    const other = stageAnalyticsVariation({ runId: "run_previous" });
    let resolveFirst: ((row: unknown) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchMock.mockResolvedValue(GOLDEN_STAGE_ANALYTICS);

    const states: EvalRunStageAnalyticsState[] = [];
    const { rerender } = render(
      <Harness runId="run_previous" onState={(state) => states.push(state)} />,
    );
    rerender(
      <Harness runId={RUN_ID} onState={(state) => states.push(state)} />,
    );
    await waitFor(() =>
      expect(states[states.length - 1]!.status).toBe("ready"),
    );

    // The stale answer arrives LAST and must be ignored.
    resolveFirst?.(other);
    await Promise.resolve();

    expect(states[states.length - 1]!.document).toEqual(GOLDEN_STAGE_ANALYTICS);
  });

  it("re-asks once the run it is watching finishes", async () => {
    // The document is materialized when the run terminalizes. A page opened
    // mid-run asks too early and gets a legitimate 404; before this the effect
    // keyed only on ids, so it never asked again — the run finished, the
    // document appeared, and the page kept showing the older rollup until
    // somebody reloaded it.
    fetchMock.mockRejectedValueOnce(
      new EvalStageAnalyticsError("notFound", "not yet", { status: 404 }),
    );
    const states: EvalRunStageAnalyticsState[] = [];
    const { rerender } = render(
      <Harness runStatus="running" onState={(s) => states.push(s)} />,
    );
    await waitFor(() =>
      expect(states[states.length - 1]!.status).toBe("absent"),
    );

    fetchMock.mockResolvedValue(GOLDEN_STAGE_ANALYTICS);
    rerender(<Harness runStatus="completed" onState={(s) => states.push(s)} />);
    await waitFor(() =>
      expect(states[states.length - 1]!.status).toBe("ready"),
    );
    expect(states[states.length - 1]!.document).toEqual(GOLDEN_STAGE_ANALYTICS);
  });

  it("does NOT re-ask on a status change that is still not terminal", async () => {
    // Collapsed to "is it over", not carried through as the raw status: a run
    // moving pending -> running says nothing about whether its document
    // exists, and re-fetching on it would issue a request per status tick.
    fetchMock.mockResolvedValue(GOLDEN_STAGE_ANALYTICS);
    const { rerender } = render(
      <Harness runStatus="pending" onState={() => {}} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<Harness runStatus="running" onState={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("asks immediately when the caller tracks no status", async () => {
    // The old behaviour, kept for callers that do not pass one — a status this
    // hook never learns must not turn into a read it never issues.
    fetchMock.mockResolvedValue(GOLDEN_STAGE_ANALYTICS);
    const { latest } = renderHook();
    await waitFor(() => expect(latest().status).toBe("ready"));
  });

  it("asks nothing at all while disabled", async () => {
    // The flag-off path. A read issued before the flag says yes is a request
    // per run per user for a feature nobody enabled.
    const { latest } = renderHook({ enabled: false });
    await waitFor(() => expect(latest().status).toBe("idle"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the previous run's document on the way IN, not on the way out", async () => {
    // A stale document left on screen while the next run loads is the same
    // wrong-answer bug the request id prevents, just with a slower fuse.
    fetchMock.mockResolvedValue(GOLDEN_STAGE_ANALYTICS);
    const states: EvalRunStageAnalyticsState[] = [];
    const { rerender } = render(
      <Harness runId={RUN_ID} onState={(state) => states.push(state)} />,
    );
    await waitFor(() =>
      expect(states[states.length - 1]!.status).toBe("ready"),
    );

    let pending = false;
    fetchMock.mockImplementation(() => {
      pending = true;
      return new Promise(() => {});
    });
    rerender(
      <Harness runId="run_next" onState={(state) => states.push(state)} />,
    );
    await waitFor(() => expect(pending).toBe(true));

    const current = states[states.length - 1]!;
    expect(current.status).toBe("loading");
    expect(current.document).toBeNull();
  });
});
