import { useConvex } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EvalIteration, EvalSuiteRun } from "./types";
import type { RunMetrics } from "./run-metrics";

const ACTIVE_STATUSES = ["pending", "running", "grading"];

/**
 * One row's identity AS READ. A settled run's detail can never change under
 * this key, so it is safe to carry across a page load; an active run's cannot
 * be cached at all, because its iterations grow while these fields stand still.
 */
function rowCacheKey(row: {
  _id: string;
  status: string;
  result?: string | null;
  completedAt?: number | null;
  summary?: unknown;
}): string | null {
  if (ACTIVE_STATUSES.includes(row.status)) return null;
  return JSON.stringify([
    row._id,
    row.status,
    row.result,
    row.completedAt,
    row.summary,
  ]);
}

export interface ProjectRunHistoryDetail {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  /**
   * Set by the suite page, which reads per-run metrics instead of iterations
   * (`iterations` is then empty). `null` means the run's metrics are still
   * loading. Absent on the project page, which reads iterations.
   */
  metrics?: RunMetrics | null;
}

type ProjectHistoryEntry = { detail: ProjectRunHistoryDetail };

/** Read requested runs, with bounded concurrency and complete iteration pages. */
export function useProjectRunHistory(
  projectId: string,
  rows: readonly {
    _id: string;
    status: string;
    result?: string | null;
    completedAt?: number | null;
    summary?: unknown;
  }[],
  enabled: boolean,
) {
  const convex = useConvex();
  const [attempt, setAttempt] = useState(0);
  // Settled runs already read on an earlier page. Without it every added page
  // re-reads the whole history, because the effect below keys on all rows.
  const settled = useRef(new Map<string, ProjectHistoryEntry>());
  const fingerprint = JSON.stringify(
    rows.map((row) => [
      row._id,
      row.status,
      row.result,
      row.completedAt,
      row.summary,
    ]),
  );
  const identity = `${projectId}:${enabled}:${fingerprint}:${attempt}`;
  const [state, setState] = useState<{
    identity: string;
    projectId: string;
    details: Map<string, ProjectRunHistoryDetail>;
    errors: Set<string>;
  }>({ identity: "", projectId: "", details: new Map(), errors: new Set() });

  useEffect(() => {
    if (!enabled || rows.length === 0) return;
    let cancelled = false;
    let next = 0;
    const details = new Map<string, ProjectRunHistoryDetail>();
    const errors = new Set<string>();
    const pending = rows.filter((row) => {
      const key = rowCacheKey(row);
      const cached = key ? settled.current.get(key) : undefined;
      if (!cached) return true;
      details.set(row._id, cached.detail);
      return false;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function worker() {
      while (!cancelled && next < pending.length) {
        const row = pending[next++];
        try {
          const run = (await convex.query("testSuites:getTestSuiteRun" as any, {
            runId: row._id,
          })) as EvalSuiteRun | null;
          if (!run) throw new Error("Run is unavailable");
          const iterations = new Map<string, EvalIteration>();
          let cursor: string | null = null;
          let complete = false;
          for (let pageIndex = 0; pageIndex < 10 && !cancelled; pageIndex++) {
            const page = (await convex.query(
              "testSuites:listTestSuiteRunIterations" as any,
              {
                runId: row._id,
                paginationOpts: { numItems: 200, cursor },
              },
            )) as {
              page: EvalIteration[];
              isDone: boolean;
              continueCursor: string;
            };
            for (const iteration of page.page)
              iterations.set(iteration._id, iteration);
            if (page.isDone) {
              complete = true;
              break;
            }
            if (!page.continueCursor || page.continueCursor === cursor) break;
            cursor = page.continueCursor;
          }
          // A partial population cannot supply totals or latency percentiles.
          if (!complete) throw new Error("Iteration history is incomplete");
          const detail = { run, iterations: [...iterations.values()] };
          details.set(row._id, detail);
          const key = rowCacheKey(row);
          if (key) settled.current.set(key, { detail });
        } catch {
          errors.add(row._id);
        }
      }
    }
    // Publish a complete snapshot once, so members never briefly appear as
    // separate runs. Keep the previous snapshot visible during live refreshes.
    void Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, worker),
    ).then(() => {
      if (!cancelled)
        setState((previous) => {
          if (previous.projectId === projectId) {
            for (const id of errors) {
              const cached = previous.details.get(id);
              if (cached) details.set(id, cached);
            }
          }
          return { identity, projectId, details, errors };
        });
      // Start the next refresh after this one finishes, even on slow histories.
      if (
        !cancelled &&
        rows.some((row) =>
          ["pending", "running", "grading"].includes(row.status),
        )
      ) {
        timer = setTimeout(() => setAttempt((value) => value + 1), 15_000);
      }
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [convex, identity]);

  const current = state.identity === identity;
  const rowIds = rows.map((row) => row._id).join(",");
  // One Map per snapshot, not per render: consumers key large `useMemo`s on
  // this identity, and the filter below is O(details x rows).
  const details = useMemo(() => {
    if (!enabled || state.projectId !== projectId)
      return new Map<string, ProjectRunHistoryDetail>();
    const ids = new Set(rowIds ? rowIds.split(",") : []);
    return new Map(
      [...state.details].filter(([id]) => ids.has(id)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, state.projectId, state.details, rowIds]);
  const errors = current ? state.errors : new Set<string>();
  return {
    details,
    errorCount: errors.size,
    loading: enabled && rows.length > 0 && !current,
    retry: () => {
      // A retry is for rows that failed, and a failed row was never cached —
      // but the user is asking to re-read, so nothing is served from memory.
      settled.current.clear();
      setAttempt((value) => value + 1);
    },
  };
}
