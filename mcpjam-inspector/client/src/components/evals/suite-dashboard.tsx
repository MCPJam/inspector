import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SuiteRunsChartGrid } from "./suite-runs-chart-grid";
import { SuiteInsightsCollapsible } from "./suite-insights-collapsible";
import { SuiteRunsList } from "./suite-runs-list";
import { TestCasesOverview } from "./test-cases-overview";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";

interface RunTrendPoint {
  runId: string;
  runIdDisplay: string;
  passRate: number;
  passed?: number;
  total?: number;
  label: string;
}

interface ModelStat {
  model: string;
  passRate: number;
  passed: number;
  failed: number;
  total: number;
}

type SuiteDashboardTab = "runs" | "cases";

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
  runTestCaseDisabledReason?: string | null;
  connectedServerNames?: Set<string>;
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  testCasesClickHint?: string;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
}

/**
 * Unified suite detail view: persistent accuracy chart + run insights, then
 * a Runs / Cases sub-tab switcher. Defaults to Cases when no runs exist so
 * the empty state nudges authoring; otherwise Runs is the hero.
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
  runTestCaseDisabledReason,
  connectedServerNames,
  onDeleteTestCasesBatch,
  testCasesClickHint,
  userMap,
}: SuiteDashboardProps) {
  const hasRuns = runs.length > 0;
  const hostNamesById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const attachment of suite.hostAttachments ?? []) {
      map.set(attachment.namedHostId, attachment.hostName);
    }
    return map;
  }, [suite.hostAttachments]);

  const [activeTab, setActiveTab] = useState<SuiteDashboardTab>(
    hasRuns ? "runs" : "cases"
  );

  const testCasesSection = (
    <TestCasesOverview
      suite={suite}
      cases={cases}
      runs={runs}
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
      runTestCaseDisabledReason={runTestCaseDisabledReason}
      connectedServerNames={connectedServerNames}
    />
  );

  const runsSection = (
    <SuiteRunsList
      suite={suite}
      cases={cases}
      runs={runs}
      allIterations={allIterations}
      suiteSource={suite.source}
      onRunClick={onRunClick}
      onTestCaseClick={onTestCaseClick}
      userMap={userMap}
      runsLoading={runsLoading}
      hostNamesById={hostNamesById}
    />
  );

  const renderTab = (
    next: SuiteDashboardTab,
    label: string,
    count?: number
  ) => {
    const active = activeTab === next;
    return (
      <button
        key={next}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setActiveTab(next)}
        className={cn(
          "relative -mb-px flex items-center gap-2 border-b-2 border-transparent px-1 pb-3 pt-1 text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2",
          active
            ? "border-primary text-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <span>{label}</span>
        {typeof count === "number" ? (
          <span className="text-xs font-normal tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
      </button>
    );
  };

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
      <div
        role="tablist"
        aria-label="Suite content"
        className="flex w-full shrink-0 items-center gap-8 border-b border-border/40"
      >
        {renderTab("runs", "Runs", runs.length)}
        {renderTab("cases", "Cases", cases.length)}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === "runs" ? runsSection : testCasesSection}
      </div>
    </div>
  );
}
