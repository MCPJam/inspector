/**
 * The stage-analytics fetch hook.
 *
 * The four things worth pinning are all about NOT painting the wrong answer:
 * an out-of-order response must never overwrite a newer one, unmounting must
 * abort rather than write into a dead component, switching suites must reset
 * the walk rather than inherit cursors that describe different runs, and a
 * later page failing must never destroy the pages already on screen.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEvalSuiteStageAnalytics } from "../use-eval-suite-stage-analytics";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";
import type { EvalSuiteStageAnalyticsState } from "../use-eval-suite-stage-analytics";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/apis/eval-stage-analytics-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/eval-stage-analytics-api")
  >("@/lib/apis/eval-stage-analytics-api");
  return { ...actual, fetchEvalSuiteStageAnalytics: fetchMock };
});

const SUITE_ID = GOLDEN_STAGE_ANALYTICS.suiteId;

function Harness({
  projectId = "p1",
  suiteId = SUITE_ID,
  onState,
}: {
  projectId?: string | null;
  suiteId?: string | null;
  onState: (state: EvalSuiteStageAnalyticsState) => void;
}) {
  onState(useEvalSuiteStageAnalytics({ projectId, suiteId }));
  return null;
}

function renderHook(props: Partial<Parameters<typeof Harness>[0]> = {}) {
  const states: EvalSuiteStageAnalyticsState[] = [];
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

describe("useEvalSuiteStageAnalytics", () => {
  it("loads the first page and reports ready", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });

    const { latest } = renderHook();
    await waitFor(() => expect(latest().status).toBe("ready"));

    expect(latest().rows).toHaveLength(1);
    expect(latest().canLoadMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        suiteId: SUITE_ID,
        limit: 25,
      }),
      expect.any(AbortSignal),
    );
  });

  it("reports a failure as an error state, never as an empty ready", async () => {
    fetchMock.mockRejectedValue(new Error("upstream down"));

    const { latest } = renderHook();
    await waitFor(() => expect(latest().status).toBe("error"));

    // Empty AND error is the state the panel must be able to tell from
    // empty AND ready — one is "no data", the other is "we could not ask".
    expect(latest().rows).toEqual([]);
    expect(latest().error?.kind).toBe("requestFailed");
  });

  it("aborts the in-flight read on unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_params: unknown, signal?: AbortSignal) =>
        new Promise(() => {
          capturedSignal = signal;
        }),
    );

    const { unmount } = renderHook();
    await waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal!.aborted).toBe(false);

    unmount();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("resets the walk when the suite changes", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });

    const states: EvalSuiteStageAnalyticsState[] = [];
    const { rerender } = render(
      <Harness suiteId={SUITE_ID} onState={(s) => states.push(s)} />,
    );
    await waitFor(() =>
      expect(states[states.length - 1]!.status).toBe("ready"),
    );

    const other = stageAnalyticsVariation({
      suiteId: "suite_other",
      runId: "run_other",
    });
    fetchMock.mockResolvedValue({ rows: [other] });
    rerender(<Harness suiteId="suite_other" onState={(s) => states.push(s)} />);

    await waitFor(() =>
      expect(states[states.length - 1]!.rows[0]?.runId).toBe("run_other"),
    );
    // The previous suite's documents are gone, not merged in beneath the new
    // ones — they describe a different set of runs entirely.
    expect(states[states.length - 1]!.rows).toHaveLength(1);
  });

  it("accumulates later pages and dedupes by runId", async () => {
    const second = stageAnalyticsVariation({ runId: "run_second" });
    fetchMock
      .mockResolvedValueOnce({
        rows: [GOLDEN_STAGE_ANALYTICS],
        nextCursor: "c2",
      })
      .mockResolvedValueOnce({
        // The first run repeats — a cursor boundary that shifted under a
        // concurrent write must not make one run appear twice.
        rows: [GOLDEN_STAGE_ANALYTICS, second],
      });

    const { latest } = renderHook();
    await waitFor(() => expect(latest().canLoadMore).toBe(true));

    act(() => latest().loadMore());
    await waitFor(() => expect(latest().rows).toHaveLength(2));

    expect(latest().rows.map((row) => row.runId)).toEqual([
      GOLDEN_STAGE_ANALYTICS.runId,
      "run_second",
    ]);
    expect(latest().canLoadMore).toBe(false);
  });

  it("keeps earlier pages when a later page fails, and retries just that page", async () => {
    const second = stageAnalyticsVariation({ runId: "run_second" });
    fetchMock
      .mockResolvedValueOnce({
        rows: [GOLDEN_STAGE_ANALYTICS],
        nextCursor: "c2",
      })
      .mockRejectedValueOnce(new Error("page two exploded"))
      .mockResolvedValueOnce({ rows: [second] });

    const { latest } = renderHook();
    await waitFor(() => expect(latest().canLoadMore).toBe(true));

    act(() => latest().loadMore());
    await waitFor(() => expect(latest().pageError).not.toBeNull());

    // NON-DESTRUCTIVE: page one is still on screen.
    expect(latest().rows).toHaveLength(1);
    expect(latest().status).toBe("ready");

    act(() => latest().retryFailedPage());
    await waitFor(() => expect(latest().rows).toHaveLength(2));
    expect(latest().pageError).toBeNull();
  });

  it("does not replay a cursor it has already walked", async () => {
    fetchMock
      .mockResolvedValueOnce({
        rows: [GOLDEN_STAGE_ANALYTICS],
        nextCursor: "c2",
      })
      // The backend hands back the SAME cursor — a walk that replayed it would
      // append the same runs forever.
      .mockResolvedValueOnce({
        rows: [stageAnalyticsVariation({ runId: "run_second" })],
        nextCursor: "c2",
      });

    const { latest } = renderHook();
    await waitFor(() => expect(latest().canLoadMore).toBe(true));

    act(() => latest().loadMore());
    await waitFor(() => expect(latest().rows).toHaveLength(2));

    const callsBefore = fetchMock.mock.calls.length;
    act(() => latest().loadMore());
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("stays idle without a project or suite", async () => {
    const { latest } = renderHook({ suiteId: null });
    await waitFor(() => expect(latest().status).toBe("idle"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
