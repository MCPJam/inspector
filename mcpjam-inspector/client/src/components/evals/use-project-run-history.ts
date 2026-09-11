import { useConvex } from "convex/react";
import { useEffect, useState } from "react";
import type { EvalIteration, EvalSuiteRun } from "./types";

export interface ProjectRunHistoryDetail {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
}

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function worker() {
      while (!cancelled && next < rows.length) {
        const row = rows[next++];
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
          details.set(row._id, { run, iterations: [...iterations.values()] });
        } catch {
          errors.add(row._id);
        }
      }
    }
    // Publish a complete snapshot once, so members never briefly appear as
    // separate runs. Keep the previous snapshot visible during live refreshes.
    void Promise.all(
      Array.from({ length: Math.min(4, rows.length) }, worker),
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
  const details =
    enabled && state.projectId === projectId
      ? new Map(
          [...state.details].filter(([id]) =>
            rows.some((row) => row._id === id),
          ),
        )
      : new Map<string, ProjectRunHistoryDetail>();
  const errors = current ? state.errors : new Set<string>();
  return {
    details,
    errorCount: errors.size,
    loading: enabled && rows.length > 0 && !current,
    retry: () => setAttempt((value) => value + 1),
  };
}
