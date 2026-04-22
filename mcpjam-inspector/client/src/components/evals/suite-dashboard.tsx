import { SuiteHeroStats } from "./suite-hero-stats";
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
  onReplayLatestRun?: (run: EvalSuiteRun) => void;
  isReplayingLatestRun?: boolean;
  missingReplayProviderKeys?: string[];
  userMap?: Map<string, { name: string; imageUrl?: string }>;
}

/**
 * Unified suite detail view: hero stats + trend/insights charts on top, with
 * test cases and recent runs surfaced side-by-side below. Replaces the nested
 * "Test cases" / "Executions" tab selector so both lists are visible at once.
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
  onReplayLatestRun,
  isReplayingLatestRun,
  missingReplayProviderKeys,
  userMap,
}: SuiteDashboardProps) {
  const hasRuns = runs.length > 0;
  const isSDK = suite.source === "sdk";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <SuiteHeroStats
        runs={runs}
        allIterations={allIterations}
        runTrendData={runTrendData}
        modelStats={modelStats}
        testCaseCount={cases.length}
        isSDK={isSDK}
        onRunClick={onRunClick}
        onReplayLatestRun={onReplayLatestRun}
        isReplayingLatestRun={isReplayingLatestRun}
        missingReplayProviderKeys={missingReplayProviderKeys}
      />
      {hasRuns ? (
        <>
          <SuiteRunsChartGrid
            suiteSource={suite.source}
            runTrendData={runTrendData}
            modelStats={modelStats}
            runsLoading={runsLoading}
            onRunClick={onRunClick}
          />
          <SuiteInsightsCollapsible runs={runs} />
        </>
      ) : null}
      <div className="grid min-h-0 gap-4 xl:grid-cols-2">
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
