/**
 * Fetch hook for a suite's materialized stage analytics (D5c).
 *
 * The no-store variant, on purpose. `use-eval-run-decision-summary.ts` pages
 * through an LRU store because dozens of run rows each ask for their own
 * summary and the dedupe is what keeps that from being dozens of requests. This
 * surface is ONE panel on one suite page; a store would be machinery with no
 * second caller, so this follows `use-run-disclosure.ts` instead — status
 * state, a monotonic request id so an out-of-order response can never paint
 * over a newer one, and an `AbortController` per effect.
 *
 * Paging follows `useEvalRunDecisionDetail`'s cursor-array shape: each cursor
 * is its own request, a later page failing never destroys the pages already
 * read, and a cursor already walked is never replayed. What it does NOT do is
 * merge the pages into a single funnel — each row is one run's complete
 * document and there is no honest cross-run aggregate to compute, so pages
 * accumulate as a LIST of runs and the panel renders one of them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";
import {
  fetchEvalSuiteStageAnalytics,
  isEvalStageAnalyticsError,
  type StageAnalyticsFailureKind,
} from "@/lib/apis/eval-stage-analytics-api";

export type StageAnalyticsStatus = "idle" | "loading" | "ready" | "error";

export interface StageAnalyticsErrorInfo {
  message: string;
  /**
   * Which of the four failures this is. Carried rather than flattened to a
   * message because the panel renders them differently: `routeUnavailable` and
   * `requestFailed` are SERVICE states ("we could not measure this"), while
   * `invalidContract` is a bug report and `notFound` is a fact about the suite.
   * None of them is an empty chart.
   */
  kind: StageAnalyticsFailureKind;
  status?: number;
}

export interface EvalSuiteStageAnalyticsState {
  status: StageAnalyticsStatus;
  /** Accumulated documents, newest run completion first, deduped by `runId`. */
  rows: EvalStageAnalyticsV1[];
  error: StageAnalyticsErrorInfo | null;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  /** A LATER page's failure. Never clears the pages already read. */
  pageError: StageAnalyticsErrorInfo | null;
  loadMore: () => void;
  retryFailedPage: () => void;
}

/** Default page size — mirrors the route's own default. */
export const STAGE_ANALYTICS_PAGE_LIMIT = 25;

function toErrorInfo(error: unknown): StageAnalyticsErrorInfo {
  if (isEvalStageAnalyticsError(error)) {
    return {
      message: error.message,
      kind: error.kind,
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    kind: "requestFailed",
  };
}

export function useEvalSuiteStageAnalytics({
  projectId,
  suiteId,
  enabled = true,
  limit = STAGE_ANALYTICS_PAGE_LIMIT,
}: {
  projectId: string | null | undefined;
  suiteId: string | null | undefined;
  enabled?: boolean;
  limit?: number;
}): EvalSuiteStageAnalyticsState {
  const active = Boolean(enabled && projectId && suiteId);

  const [rows, setRows] = useState<EvalStageAnalyticsV1[]>([]);
  const [status, setStatus] = useState<StageAnalyticsStatus>("idle");
  const [error, setError] = useState<StageAnalyticsErrorInfo | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [pendingCursor, setPendingCursor] = useState<string | undefined>(
    undefined,
  );
  const [pageError, setPageError] = useState<StageAnalyticsErrorInfo | null>(
    null,
  );
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Every cursor already walked. A cursor is never replayed: a backend that
  // returns the same cursor twice would otherwise loop forever, appending the
  // same runs on each pass.
  const walkedRef = useRef<Set<string>>(new Set());
  // Monotonic request id. Only the newest in-flight request may write state.
  const requestIdRef = useRef(0);

  // A new suite (or project) is a new walk. Without this the second suite would
  // inherit the first's cursors and rows, which describe different runs.
  const identity = `${projectId ?? ""}::${suiteId ?? ""}::${limit}`;
  const previousIdentity = useRef(identity);
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity;
    walkedRef.current = new Set();
    requestIdRef.current += 1;
    if (rows.length > 0) setRows([]);
    if (nextCursor !== undefined) setNextCursor(undefined);
    if (pendingCursor !== undefined) setPendingCursor(undefined);
    if (pageError !== null) setPageError(null);
    if (error !== null) setError(null);
    if (isLoadingMore) setIsLoadingMore(false);
    if (status !== "idle") setStatus("idle");
  }

  // ── the first page ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      requestIdRef.current += 1;
      setStatus("idle");
      setRows([]);
      setError(null);
      setNextCursor(undefined);
      return;
    }

    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        const page = await fetchEvalSuiteStageAnalytics(
          {
            projectId: projectId as string,
            suiteId: suiteId as string,
            limit,
          },
          controller.signal,
        );
        if (requestId !== requestIdRef.current) return;
        walkedRef.current = new Set();
        setRows(page.rows);
        setNextCursor(page.nextCursor);
        setStatus("ready");
      } catch (err) {
        // An abort is the caller's own teardown, not a failure to report.
        if (controller.signal.aborted) return;
        if (requestId !== requestIdRef.current) return;
        setRows([]);
        setNextCursor(undefined);
        setError(toErrorInfo(err));
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [active, projectId, suiteId, limit]);

  // ── later pages ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || pendingCursor === undefined) return;

    const controller = new AbortController();
    setIsLoadingMore(true);
    setPageError(null);

    void (async () => {
      try {
        const page = await fetchEvalSuiteStageAnalytics(
          {
            projectId: projectId as string,
            suiteId: suiteId as string,
            limit,
            cursor: pendingCursor,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        walkedRef.current.add(pendingCursor);
        // Deduped by `runId`: one run has exactly one document, and a cursor
        // boundary that shifted under a concurrent write must not make one run
        // appear twice in the list.
        setRows((current) => {
          const seen = new Set(current.map((row) => row.runId));
          return [
            ...current,
            ...page.rows.filter((row) => !seen.has(row.runId)),
          ];
        });
        setNextCursor(page.nextCursor);
        setIsLoadingMore(false);
        setPendingCursor(undefined);
      } catch (err) {
        if (controller.signal.aborted) return;
        // NON-DESTRUCTIVE: the pages already read stay on screen, and the
        // cursor stays un-walked so a retry can ask for the same page again.
        setPageError(toErrorInfo(err));
        setIsLoadingMore(false);
        setPendingCursor(undefined);
      }
    })();

    return () => controller.abort();
  }, [active, projectId, suiteId, limit, pendingCursor]);

  const loadMore = useCallback(() => {
    if (!nextCursor || walkedRef.current.has(nextCursor)) return;
    setPendingCursor(nextCursor);
  }, [nextCursor]);

  const retryFailedPage = useCallback(() => {
    if (!nextCursor || !pageError) return;
    setPendingCursor(nextCursor);
  }, [nextCursor, pageError]);

  const canLoadMore = useMemo(
    () => Boolean(nextCursor) && !isLoadingMore,
    [nextCursor, isLoadingMore],
  );

  return {
    status,
    rows,
    error,
    canLoadMore,
    isLoadingMore,
    pageError,
    loadMore,
    retryFailedPage,
  };
}
