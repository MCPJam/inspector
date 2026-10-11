import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import type { EvalSuiteRunListItem } from "./types";

/** Finish a selected group through small transactions, never an unbounded query. */
export async function readRunGroupSummaries(
  query: (name: any, args: any) => Promise<any>,
  suiteId: string,
  runGroupId: string,
): Promise<EvalSuiteRunListItem[]> {
  const rows = new Map<string, EvalSuiteRunListItem>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await query("testSuites:listTestSuiteRunSummaries", {
      suiteId,
      runGroupId,
      paginationOpts: { numItems: 20, cursor },
    });
    for (const row of page.page as EvalSuiteRunListItem[])
      rows.set(row._id, row);
    if (page.isDone) {
      if (rows.size === 0) throw new Error("Run group unavailable");
      return [...rows.values()];
    }
    if (!page.continueCursor || cursors.has(page.continueCursor))
      throw new Error("Run group history is incomplete");
    cursors.add(page.continueCursor);
    cursor = page.continueCursor;
  }
}

export function useRunGroupSummaries(
  suiteId: string,
  runs: readonly EvalSuiteRunListItem[],
) {
  const convex = useConvex();
  const currentSuite = useRef(suiteId);
  currentSuite.current = suiteId;
  const [state, setState] = useState<{
    suiteId: string;
    groups: Map<string, EvalSuiteRunListItem[]>;
  }>({ suiteId, groups: new Map() });
  const loadGroup = useCallback(
    async (runGroupId: string) => {
      const rows = await readRunGroupSummaries(
        convex.query.bind(convex),
        suiteId,
        runGroupId,
      );
      if (currentSuite.current !== suiteId) return rows;
      setState((previous) => ({
        suiteId,
        groups: new Map(
          previous.suiteId === suiteId ? previous.groups : [],
        ).set(runGroupId, rows),
      }));
      return rows;
    },
    [convex, suiteId],
  );
  const forgetRuns = useCallback((ids: readonly string[]) => {
    const deleted = new Set(ids);
    setState((previous) => ({
      ...previous,
      groups: new Map(
        [...previous.groups].map(([id, rows]) => [
          id,
          rows.filter((row) => !deleted.has(row._id)),
        ]),
      ),
    }));
  }, []);
  const mergedRuns = useMemo(() => {
    const merged = new Map<string, EvalSuiteRunListItem>();
    if (state.suiteId === suiteId)
      for (const group of state.groups.values())
        for (const run of group) merged.set(run._id, run);
    for (const run of runs) merged.set(run._id, run);
    return [...merged.values()];
  }, [state, suiteId, runs]);
  return { runs: mergedRuns, loadGroup, forgetRuns };
}
