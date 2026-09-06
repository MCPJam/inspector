import { useMemo, useState } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import {
  SuiteInsightsCollapsible,
  type InsightGroupScope,
} from "./suite-insights-collapsible";
import { SuiteMetricStrip } from "./suite-metric-strip";
import { TestCasesOverview } from "./test-cases-overview";
import type { CrossHostEnvironment } from "./cross-host/use-cross-host-data";
import { SuiteResultsSplit } from "./suite-results-split";
import { buildHostNamesById } from "./helpers";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";
import { isModelFree } from "@/shared/steps";

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
  /**
   * Open a specific iteration in the standardized case editor (split layout,
   * no legacy compare header). Wired to matrix cell clicks.
   */
  onOpenCaseIteration?: (testCaseId: string, iterationId: string) => void;
  /** Click a run row — opens run detail. */
  onRunClick: (runId: string) => void;
  /** Delete a single run (rail hover trash; groups delete all their host runs). */
  onDirectDeleteRun?: (runId: string) => Promise<void>;
  /** Per-row Run button inside the cases list. */
  onRunTestCase?: (testCase: EvalCase) => void;
  runningTestCaseId?: string | null;
  blockTestCaseRuns?: boolean;
  runTestCaseDisabledReason?: string | null;
  connectedServerNames?: Set<string>;
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  testCasesClickHint?: string;
  /** Retained for prop compatibility with the parent factory; unused here. */
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  /** Empty-state CTAs in the case library — same actions as the suite header. */
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  generateTestCasesDisabledReason?: string;
  isGeneratingTestCases?: boolean;
  onCreateTestCase?: () => void;
  onRecordTestCase?: () => void;
  /** Evaluate (New) only; passed straight through to the cases table. */
  simpleCaseEditor?: boolean;
  /**
   * When set, the results split shows this run's detail in its right pane
   * (the rail highlights the run). Drives the folded-in run-detail view; the
   * parent owns the URL, so this is the run currently in the URL.
   */
  selectedRunId?: string | null;
  /** Prebuilt run-detail surface (RunDetailView) rendered when a run is selected. */
  runDetailPane?: React.ReactNode;
  /** Leave the selected run (back to suite overview) — clears the URL run id. */
  onExitRun?: () => void;
  /**
   * `namedHostId` → display name, spanning the suite's attachments AND the
   * project host list (see `buildHostNamesById`). The project list is the only
   * source for a host with no attachment — the resolved host of an
   * environment-backed run. Falls back to attachment names alone when omitted.
   */
  hostNamesById?: Map<string, string | null>;
  /**
   * The suite's project environments, owned by the parent like `hostNamesById`.
   * Without them the matrix can only place a run by its resolved host, so two
   * model cells on one client share a column.
   */
  environments?: readonly CrossHostEnvironment[];
  /** Forwarded to the per-case credit estimate (quick-run iteration override). */
  quickRunIterationOverride?: number;
}

/**
 * Suite detail view: persistent accuracy strip + run insights, then the unified
 * master-detail results surface (run-group rail + scoped right pane). This is
 * the single surface for browsing runs, cases, run groups, and a folded-in
 * single-run detail — there is no longer a Runs/Cases tab switcher.
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
  onOpenCaseIteration,
  onRunClick,
  onDirectDeleteRun,
  onRunTestCase,
  runningTestCaseId,
  blockTestCaseRuns,
  runTestCaseDisabledReason,
  connectedServerNames,
  onDeleteTestCasesBatch,
  testCasesClickHint,
  onGenerateTestCases,
  canGenerateTestCases,
  generateTestCasesDisabledReason,
  isGeneratingTestCases,
  onCreateTestCase,
  onRecordTestCase,
  simpleCaseEditor,
  selectedRunId,
  runDetailPane,
  onExitRun,
  hostNamesById: hostNamesByIdProp,
  environments,
  quickRunIterationOverride,
}: SuiteDashboardProps) {
  const hasRuns = runs.length > 0;
  const attachmentHostNames = useMemo(
    () => buildHostNamesById(suite.hostAttachments, undefined),
    [suite.hostAttachments],
  );
  const hostNamesById = hostNamesByIdProp ?? attachmentHostNames;

  // Monitoring rail item: synthetic-monitors flag AND the suite actually has
  // monitoring signal (a schedule or at least one widget probe case).
  const syntheticMonitorsEnabled =
    useFeatureFlagEnabled("synthetic-monitors") === true;
  const showMonitoring =
    syntheticMonitorsEnabled &&
    (Boolean(suite.schedule) ||
      cases.some((testCase) => isModelFree(testCase.steps)));

  // The case-authoring library (with add / delete / run affordances). The split
  // shows it as the "All runs" pane before any host-scoped run data exists, so
  // empty states and authoring survive on fresh / attachment-less suites.
  const caseLibrary = (
    <TestCasesOverview
      suite={suite}
      cases={cases}
      runs={runs}
      allIterations={allIterations}
      runsViewMode="test-cases"
      onViewModeChange={() => {}}
      onTestCaseClick={onTestCaseClick}
      showClientResultColumns
      clickHint={testCasesClickHint}
      runTrendData={runTrendData}
      modelStats={modelStats}
      runsLoading={runsLoading}
      onRunClick={onRunClick}
      hideViewModeSelect
      fillAvailableHeight
      onOpenLastRun={onOpenLastRun}
      onDeleteTestCasesBatch={onDeleteTestCasesBatch}
      onRunTestCase={onRunTestCase}
      quickRunIterationOverride={quickRunIterationOverride}
      runningTestCaseId={runningTestCaseId}
      blockTestCaseRuns={blockTestCaseRuns}
      runTestCaseDisabledReason={runTestCaseDisabledReason}
      connectedServerNames={connectedServerNames}
      onGenerateTestCases={onGenerateTestCases}
      canGenerateTestCases={canGenerateTestCases}
      generateTestCasesDisabledReason={generateTestCasesDisabledReason}
      isGeneratingTestCases={isGeneratingTestCases}
      onCreateTestCase={onCreateTestCase}
      onRecordTestCase={onRecordTestCase}
      simpleCaseEditor={simpleCaseEditor}
      hostNamesById={hostNamesById}
      environments={environments}
    />
  );

  // The top band is constant across All-runs and a selected run, so switching
  // never shifts the chrome. The metric strip is the same 4-card component
  // either way — suite-aggregate (with trends) by default, or scoped to the
  // run's point-in-time numbers when one is selected. Run insights stays pinned
  // too (suite latest-vs-previous context); the run pane's own AI insights live
  // in its side panel.
  // Selected multi-host run group reported up by the results split; drives the
  // banner's cross-host diagnosis mode.
  const [groupScope, setGroupScope] = useState<InsightGroupScope | null>(null);

  // Scope the header KPIs the same way the results split + insight banner scope:
  // a single selected run → its point-in-time numbers; a selected run group →
  // that launch's host runs aggregated; otherwise the whole suite (with trends).
  // `selectedRunId` wins over `groupScope` because opening a child run is a
  // narrower selection than its parent group.
  const scopedRunIds = useMemo<Set<string> | null>(() => {
    if (selectedRunId) return new Set([selectedRunId]);
    if (groupScope) return new Set(groupScope.runs.map((r) => r._id));
    return null;
  }, [selectedRunId, groupScope]);

  const metricRuns = scopedRunIds
    ? runs.filter((r) => scopedRunIds.has(r._id))
    : runs;
  const metricIterations = scopedRunIds
    ? allIterations.filter(
        (i) => i.suiteRunId && scopedRunIds.has(i.suiteRunId),
      )
    : allIterations;
  // A group is a single launch across hosts → aggregate to one point-in-time
  // reading (no per-host "trend"). A single run is already one point.
  const metricAggregate = !selectedRunId && groupScope != null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      {hasRuns ? (
        <div className="shrink-0">
          <SuiteMetricStrip
            runs={metricRuns}
            allIterations={metricIterations}
            aggregate={metricAggregate}
          />
        </div>
      ) : null}
      {hasRuns ? (
        <div className="shrink-0">
          <SuiteInsightsCollapsible
            runs={runs}
            groupScope={groupScope}
            selectedRunId={selectedRunId}
          />
        </div>
      ) : null}
      <SuiteResultsSplit
        onGroupScopeChange={setGroupScope}
        suite={suite}
        cases={cases}
        runs={runs}
        allIterations={allIterations}
        hostNamesById={hostNamesById}
        environments={environments}
        allRunsPane={caseLibrary}
        onTestCaseClick={onTestCaseClick}
        onOpenCaseIteration={onOpenCaseIteration}
        onRunClick={onRunClick}
        showMonitoring={showMonitoring}
        selectedRunId={selectedRunId}
        runDetailPane={runDetailPane}
        onExitRun={onExitRun}
        onDeleteRun={onDirectDeleteRun}
        onDeleteTestCasesBatch={onDeleteTestCasesBatch}
      />
    </div>
  );
}
