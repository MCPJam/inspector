/**
 * The React subscribers over the decision-summary controller, and the
 * diagnostics walk in particular.
 *
 * The walk is the part with teeth. A run's non-passing trials arrive one
 * bounded page at a time, and the three ways a naive implementation gets that
 * wrong are all silent:
 *
 *   - **Reinterpreting `complete`.** The server's completeness claim is about
 *     the whole non-passing set. A client that finished following the cursors
 *     it was handed has learned something ELSE, and reporting the two as one
 *     fact upgrades "here are some of the failures" to "here are the
 *     failures".
 *   - **Losing earlier pages on a later failure.** Page three failing says
 *     nothing about pages one and two, and blanking the list on that failure
 *     hides evidence that arrived successfully.
 *   - **Counting an iteration twice.** An iteration is ONE trial however many
 *     pages mention it; listed twice it reads as two failures.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useEvalRunDecisionBadge,
  useEvalRunDecisionDetail,
} from "../use-eval-run-decision-summary";
import {
  DECISION_SUMMARY_BADGE_LIMIT,
  DECISION_SUMMARY_DETAIL_LIMIT,
  EvalDecisionSummaryStore,
} from "@/lib/evals/eval-decision-summary-store";
import { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import type { EvalRunDecisionSummary } from "@mcpjam/sdk/contract";

const PARTIAL = readDecisionSummaryFixture("partial-diagnostics-page");
const SIX_FAILURES = readDecisionSummaryFixture(
  "measured-failure-at-every-stage",
);

interface Recorded {
  params: { projectId: string; runId: string; limit: number; cursor?: string };
  resolve: (summary: EvalRunDecisionSummary) => void;
  reject: (error: unknown) => void;
}

function recordingStore(options?: { staleMs?: number }) {
  const calls: Recorded[] = [];
  const fetcher = vi.fn(
    (
      params: {
        projectId: string;
        runId: string;
        limit?: number;
        cursor?: string;
      },
    ) =>
      new Promise<EvalRunDecisionSummary>((resolve, reject) => {
        calls.push({
          params: { ...params, limit: params.limit ?? 0 },
          resolve,
          reject,
        });
      }),
  );
  const store = new EvalDecisionSummaryStore({
    fetcher: fetcher as never,
    staleMs: options?.staleMs ?? 1_000_000,
  });
  return { calls, store };
}

/** Let a settled fetch flush through the store and into a re-render. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A second page of diagnostics, built from the corpus's own rows. */
function pageTwo(overrides: {
  items: EvalRunDecisionSummary["diagnostics"]["items"];
  complete: boolean;
  scannedIterations: number;
  nextCursor?: string;
}): EvalRunDecisionSummary {
  return {
    ...PARTIAL,
    diagnostics: {
      items: overrides.items,
      complete: overrides.complete,
      scannedIterations: overrides.scannedIterations,
      ...(overrides.nextCursor ? { nextCursor: overrides.nextCursor } : {}),
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useEvalRunDecisionBadge", () => {
  it("reads at limit 1, never at the detail page size", () => {
    const { calls, store } = recordingStore();

    renderHook(() =>
      useEvalRunDecisionBadge({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].params.limit).toBe(DECISION_SUMMARY_BADGE_LIMIT);
  });

  it("issues nothing at all when disabled", () => {
    const { calls, store } = recordingStore();

    const { result } = renderHook(() =>
      useEvalRunDecisionBadge({
        projectId: "p1",
        runId: "run-1",
        enabled: false,
        store,
      }),
    );

    expect(calls).toHaveLength(0);
    expect(result.current.status).toBe("disabled");
  });

  it("issues nothing without a project id rather than guessing one", () => {
    const { calls, store } = recordingStore();

    renderHook(() =>
      useEvalRunDecisionBadge({
        projectId: null,
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    expect(calls).toHaveLength(0);
  });
});

describe("useEvalRunDecisionDetail", () => {
  it("reads page one at the fixed detail page size", () => {
    const { calls, store } = recordingStore();

    renderHook(() =>
      useEvalRunDecisionDetail({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].params.limit).toBe(DECISION_SUMMARY_DETAIL_LIMIT);
    expect(calls[0].params.cursor).toBeUndefined();
  });

  it("reports the server's own `complete`, not a local reading of it", async () => {
    const { calls, store } = recordingStore();

    const { result } = renderHook(() =>
      useEvalRunDecisionDetail({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );
    calls[0].resolve(PARTIAL);
    await flush();

    expect(PARTIAL.diagnostics.complete).toBe(false);
    expect(result.current.serverComplete).toBe(false);
    expect(result.current.canLoadMore).toBe(true);
    expect(result.current.walkExhausted).toBe(false);
  });

  it("appends a page, sums the scans, and never upgrades `complete`", async () => {
    const { calls, store } = recordingStore();
    const { result } = renderHook(() =>
      useEvalRunDecisionDetail({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    calls[0].resolve(PARTIAL);
    await flush();
    const firstPageItems = result.current.diagnostics.length;
    expect(result.current.scannedIterations).toBe(
      PARTIAL.diagnostics.scannedIterations,
    );

    act(() => result.current.loadMore());
    expect(calls[1].params.cursor).toBe(PARTIAL.diagnostics.nextCursor);

    calls[1].resolve(
      pageTwo({
        // Rows the first page did not carry — `slice(1, 3)` skips `it-1`,
        // which is the one the partial page already holds.
        items: SIX_FAILURES.diagnostics.items.slice(1, 3),
        complete: false,
        scannedIterations: 3,
      }),
    );
    await flush();

    expect(result.current.diagnostics).toHaveLength(firstPageItems + 2);
    expect(result.current.scannedIterations).toBe(
      PARTIAL.diagnostics.scannedIterations + 3,
    );
    // The walk ran out of cursors. That is a fact about this client, and it
    // does NOT make the server's partial page complete.
    expect(result.current.walkExhausted).toBe(true);
    expect(result.current.serverComplete).toBe(false);
    expect(result.current.canLoadMore).toBe(false);
  });

  it("lists an iteration once even when two pages carry it", async () => {
    const { calls, store } = recordingStore();
    const { result } = renderHook(() =>
      useEvalRunDecisionDetail({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    calls[0].resolve(PARTIAL);
    await flush();
    act(() => result.current.loadMore());
    calls[1].resolve(
      pageTwo({
        // The same rows again — a replayed cursor, which is exactly how a
        // duplicate reaches a client.
        items: PARTIAL.diagnostics.items,
        complete: false,
        scannedIterations: 2,
      }),
    );
    await flush();

    const ids = result.current.diagnostics.map((item) => item.iterationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(PARTIAL.diagnostics.items.length);
  });

  it("keeps the pages it already has when a later page fails", async () => {
    const { calls, store } = recordingStore();
    const { result } = renderHook(() =>
      useEvalRunDecisionDetail({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    calls[0].resolve(PARTIAL);
    await flush();
    const before = result.current.diagnostics;
    expect(before.length).toBeGreaterThan(0);

    act(() => result.current.loadMore());
    calls[1].reject(
      new EvalRunDecisionSummaryError("requestFailed", "network down"),
    );
    await flush();

    expect(result.current.status).toBe("ready");
    expect(result.current.summary).not.toBeNull();
    expect(result.current.diagnostics).toEqual(before);
    expect(result.current.pageError?.kind).toBe("requestFailed");
  });

  it("re-reads only the failed page on retry", async () => {
    const { calls, store } = recordingStore();
    const { result } = renderHook(() =>
      useEvalRunDecisionDetail({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    calls[0].resolve(PARTIAL);
    await flush();
    act(() => result.current.loadMore());
    calls[1].reject(
      new EvalRunDecisionSummaryError("requestFailed", "network down"),
    );
    await flush();

    act(() => result.current.retryFailedPage());

    expect(calls).toHaveLength(3);
    expect(calls[2].params.cursor).toBe(PARTIAL.diagnostics.nextCursor);
  });

  it("says the whole set is in hand when the server says so", async () => {
    const { calls, store } = recordingStore();
    const { result } = renderHook(() =>
      useEvalRunDecisionDetail({
        projectId: "p1",
        runId: "run-1",
        enabled: true,
        store,
      }),
    );

    calls[0].resolve(SIX_FAILURES);
    await flush();

    expect(result.current.serverComplete).toBe(true);
    expect(result.current.canLoadMore).toBe(false);
    expect(result.current.diagnostics).toHaveLength(6);
  });

  it("starts a fresh walk when the run changes", async () => {
    const { calls, store } = recordingStore();
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) =>
        useEvalRunDecisionDetail({
          projectId: "p1",
          runId,
          enabled: true,
          store,
        }),
      { initialProps: { runId: "run-1" } },
    );

    calls[0].resolve(PARTIAL);
    await flush();
    act(() => result.current.loadMore());
    await flush();

    rerender({ runId: "run-2" });
    await flush();

    // The second run inherits no cursors from the first — those cursors index
    // a different iteration set entirely.
    const runTwoCalls = calls.filter((call) => call.params.runId === "run-2");
    expect(runTwoCalls).toHaveLength(1);
    expect(runTwoCalls[0].params.cursor).toBeUndefined();
    expect(result.current.status).toBe("loading");
    expect(result.current.diagnostics).toEqual([]);
  });

  it("does not paint a response that settles for a run it has left", async () => {
    const { calls, store } = recordingStore();
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) =>
        useEvalRunDecisionDetail({
          projectId: "p1",
          runId,
          enabled: true,
          store,
        }),
      { initialProps: { runId: "run-1" } },
    );

    rerender({ runId: "run-2" });
    // run-1's read comes back AFTER the view moved on.
    calls[0].resolve(SIX_FAILURES);
    await flush();

    expect(result.current.summary).toBeNull();
    expect(result.current.diagnostics).toEqual([]);
  });
});
