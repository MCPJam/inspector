import { useConvex } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "./types";
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

export interface ProjectRunHistoryDetail<
  TRun extends EvalSuiteRunListItem = EvalSuiteRun,
> {
  run: TRun;
  iterations: EvalIteration[];
  statusWhenRead?: string;
  /**
   * Set by the suite page, which reads per-run metrics instead of iterations
   * (`iterations` is then empty). `null` means the run's metrics are still
   * loading. Absent on the project page, which reads iterations.
   */
  metrics?: RunMetrics | null;
}

type HistoryDetail = Omit<ProjectRunHistoryDetail, "run"> & {
  run?: EvalSuiteRun;
};
type ProjectHistoryEntry = { detail: HistoryDetail };

/**
 * Module-level, so a grid that unmounts (opening a result page) and mounts
 * again (back) shows what it last read at once while the refresh runs.
 * `SETTLED` holds settled runs by row identity, so an added page does not
 * re-read the whole history; `LATEST` holds the last snapshot per set of run
 * ids, active runs included. Both drop their oldest entries past a limit.
 */
const SETTLED = new Map<string, ProjectHistoryEntry>();
const LATEST = new Map<string, Map<string, HistoryDetail>>();
// Each entry holds a run's full iteration list and lives for the tab, so the
// caps stay small: a few history pages and the last few grids.
const SETTLED_LIMIT = 100;
const LATEST_LIMIT = 5;

function remember<V>(
  cache: Map<string, V>,
  key: string,
  value: V,
  limit: number,
) {
  cache.delete(key);
  cache.set(key, value);
  const oldest = cache.keys().next();
  if (cache.size > limit && !oldest.done) cache.delete(oldest.value);
}

/** Empties the shared caches, so a test that mounts the hook starts cold. */
export function clearProjectRunHistoryCache(): void {
  SETTLED.clear();
  LATEST.clear();
}

/** Read requested runs, with bounded concurrency and complete iteration pages. */
export function useProjectRunHistory<TSnapshot extends boolean = true>(
  projectId: string,
  rows: readonly {
    _id: string;
    status: string;
    result?: string | null;
    completedAt?: number | null;
    summary?: unknown;
  }[],
  enabled: boolean,
  options: { includeRunSnapshot?: TSnapshot } = {},
) {
  const convex = useConvex();
  const includeRunSnapshot = options.includeRunSnapshot !== false;
  const [attempt, setAttempt] = useState(0);
  const fingerprint = JSON.stringify(
    rows.map((row) => [
      row._id,
      row.status,
      row.result,
      row.completedAt,
      row.summary,
    ]),
  );
  const identity = `${projectId}:${enabled}:${includeRunSnapshot}:${fingerprint}:${attempt}`;
  const rowIds = rows.map((row) => row._id).join(",");
  const latestKey = `${projectId}:${includeRunSnapshot}:${rowIds}`;
  const [state, setState] = useState<{
    identity: string;
    projectId: string;
    details: Map<string, HistoryDetail>;
    errors: Set<string>;
  }>(() => ({
    identity: "",
    projectId: LATEST.has(latestKey) ? projectId : "",
    details: LATEST.get(latestKey) ?? new Map(),
    errors: new Set(),
  }));

  useEffect(() => {
    if (!enabled || rows.length === 0) return;
    let cancelled = false;
    let next = 0;
    const details = new Map<string, HistoryDetail>();
    const errors = new Set<string>();
    const pending = rows.filter((row) => {
      const baseKey = rowCacheKey(row);
      const key = baseKey ? `${includeRunSnapshot}:${baseKey}` : null;
      const cached = key ? SETTLED.get(key) : undefined;
      if (!cached) return true;
      details.set(row._id, cached.detail);
      return false;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function worker() {
      while (!cancelled && next < pending.length) {
        const row = pending[next++];
        try {
          const run = includeRunSnapshot
            ? ((await convex.query("testSuites:getTestSuiteRun" as any, {
                runId: row._id,
              })) as EvalSuiteRun | null)
            : undefined;
          if (includeRunSnapshot && !run) throw new Error("Run is unavailable");
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
          const detail = {
            run: run ?? undefined,
            statusWhenRead: row.status,
            iterations: [...iterations.values()],
          };
          details.set(row._id, detail);
          const baseKey = rowCacheKey(row);
          const key = baseKey ? `${includeRunSnapshot}:${baseKey}` : null;
          if (key) remember(SETTLED, key, { detail }, SETTLED_LIMIT);
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
      if (!cancelled) remember(LATEST, latestKey, details, LATEST_LIMIT);
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
  // One Map per snapshot, not per render: consumers key large `useMemo`s on
  // this identity, and the filter below is O(details x rows).
  const details = useMemo(() => {
    if (!enabled || state.projectId !== projectId)
      return new Map<string, HistoryDetail>();
    const ids = new Set(rowIds ? rowIds.split(",") : []);
    return new Map([...state.details].filter(([id]) => ids.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, state.projectId, state.details, rowIds]);
  const errors = current ? state.errors : new Set<string>();
  return {
    details: details as Map<
      string,
      TSnapshot extends false
        ? Omit<ProjectRunHistoryDetail, "run">
        : ProjectRunHistoryDetail
    >,
    errorCount: errors.size,
    loading: enabled && rows.length > 0 && !current,
    retry: () => {
      // A retry is for rows that failed, and a failed row was never cached —
      // but the user is asking to re-read, so nothing is served from memory.
      SETTLED.clear();
      setAttempt((value) => value + 1);
    },
  };
}
