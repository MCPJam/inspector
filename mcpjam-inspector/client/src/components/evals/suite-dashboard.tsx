import { SuiteRunsChartGrid } from "./suite-runs-chart-grid";
import { SuiteInsightsCollapsible } from "./suite-insights-collapsible";
import { SuiteRunsList } from "./suite-runs-list";
import { TestCasesOverview } from "./test-cases-overview";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "./types";

interface RunTrendPoint {
  runId: string;
  runIdDisplay: string;
  passRate: number;
  label: string;
}

interface ModelStat {
  model: string;
  passRate: number;
  passed: number;
  failed: number;
  total: number;
}

export interface SuiteDashboardProps {
  suite: EvalSuite;
  cases: EvalCase[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  runTrendData: RunTrendPoint[];
  modelStats: ModelStat[];
  /** Click a test case row — opens the case editor / detail. */
  onTestCaseClick: (testCaseId: string) => void;
  /** One-click deep-link from a case row to its latest compare iteration. */
  onOpenLastRun?: (testCaseId: string, iterationId: string) => void;
  /** Click a run row — opens run detail. */
  onRunClick: (runId: string) => void;
  /** Per-row Run button inside the cases list. */
  onRunTestCase?: (testCase: EvalCase) => void;
  runningTestCaseId?: string | null;
  blockTestCaseRuns?: boolean;
  connectedServerNames?: Set<string>;
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  testCasesClickHint?: string;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
}

/**
 * Unified suite detail view: pass-rate / model charts on top, run insights
 * under the charts when available, then test cases and runs side by side.
 */
export function SuiteDashboard({
  suite,
  cases,
  allIterations,
  runs,
  runsLoading,
  runTrendData,
  modelStats,
  onTestCaseClick,
  onOpenLastRun,
  onRunClick,
  onRunTestCase,
  runningTestCaseId,
  blockTestCaseRuns,
  connectedServerNames,
  onDeleteTestCasesBatch,
  testCasesClickHint,
  userMap,
}: SuiteDashboardProps) {
  const hasRuns = runs.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <SuiteRunsChartGrid
        suiteSource={suite.source}
        runTrendData={runTrendData}
        modelStats={modelStats}
        runsLoading={runsLoading}
        onRunClick={onRunClick}
      />
      {hasRuns ? <SuiteInsightsCollapsible runs={runs} /> : null}
      <div className="grid min-h-0 gap-4 lg:grid-cols-2">
        <TestCasesOverview
          suite={suite}
          cases={cases}
          allIterations={allIterations}
          runsViewMode="test-cases"
          onViewModeChange={() => {}}
          onTestCaseClick={onTestCaseClick}
          clickHint={testCasesClickHint}
          runTrendData={runTrendData}
          modelStats={modelStats}
          runsLoading={runsLoading}
          onRunClick={onRunClick}
          hideViewModeSelect
          onOpenLastRun={onOpenLastRun}
          onDeleteTestCasesBatch={onDeleteTestCasesBatch}
          onRunTestCase={onRunTestCase}
          runningTestCaseId={runningTestCaseId}
          blockTestCaseRuns={blockTestCaseRuns}
          connectedServerNames={connectedServerNames}
        />
        <SuiteRunsList
          runs={runs}
          allIterations={allIterations}
          suiteSource={suite.source}
          onRunClick={onRunClick}
          userMap={userMap}
          runsLoading={runsLoading}
        />
      </div>
    </div>
  );
}
