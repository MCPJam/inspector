/**
 * Cross-host dashboard for a selected run group, augmented with per-host
 * verdicts from the group judge. Kept as its own component (mounted only in the
 * group branch of the results split) so its Convex `useQuery` subscription
 * never loads on surfaces that render without a ConvexProvider (e.g. the
 * monitoring-gating tests, or the "All runs" / no-runs states).
 */
import { useMemo } from "react";
import { CrossHostDashboard } from "./cross-host/cross-host-dashboard";
import type { HostVerdictMap } from "./cross-host/cross-host-matrix";
import { useRunGroupQuality } from "./use-run-group-quality";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";
import type { CaseRowSort } from "./cross-host/case-row-metrics";
import type { CellData } from "./cross-host/use-cross-host-data";

interface GroupCrossHostDashboardProps {
  suite: EvalSuite;
  cases: EvalCase[];
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  runGroupId: string;
  caseRowSort: CaseRowSort;
  onCaseRowSortChange: (sort: CaseRowSort) => void;
  onTestCaseClick?: (testCaseId: string) => void;
  onCellOpen?: (cell: CellData, hostId: string, caseId: string) => void;
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
}

export function GroupCrossHostDashboard({
  suite,
  cases,
  runs,
  allIterations,
  runGroupId,
  caseRowSort,
  onCaseRowSortChange,
  onTestCaseClick,
  onCellOpen,
  onDeleteTestCasesBatch,
}: GroupCrossHostDashboardProps) {
  const { result } = useRunGroupQuality({
    suiteId: suite._id,
    runGroupId,
    runs,
    autoRequest: false,
  });

  const hostVerdicts = useMemo<HostVerdictMap | undefined>(() => {
    const summaries = result?.hostSummaries;
    if (!summaries?.length) return undefined;
    const map: HostVerdictMap = new Map();
    for (const h of summaries) {
      // Join on namedHostId — the matrix column key (HostColumn.hostId).
      if (h.namedHostId) {
        map.set(h.namedHostId, { verdict: h.verdict, summary: h.summary });
      }
    }
    return map.size > 0 ? map : undefined;
  }, [result]);

  return (
    <CrossHostDashboard
      suite={suite}
      cases={cases}
      runs={runs}
      allIterations={allIterations}
      expanded
      caseRowSort={caseRowSort}
      onCaseRowSortChange={onCaseRowSortChange}
      sortControlInHeader
      onTestCaseClick={onTestCaseClick}
      onCellOpen={onCellOpen}
      onDeleteTestCasesBatch={onDeleteTestCasesBatch}
      hostVerdicts={hostVerdicts}
    />
  );
}
