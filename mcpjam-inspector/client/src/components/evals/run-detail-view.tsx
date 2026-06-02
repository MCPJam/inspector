import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  formatRunId,
} from "./helpers";
import {
  computeIterationPassed,
} from "./pass-criteria";
import { EvalIteration, EvalJudgeConfig, EvalSuiteRun } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { useRunInsights } from "./use-run-insights";
import { useServerQuality } from "./use-server-quality";
import { useGoalCompletion } from "./use-goal-completion";
import { AiTriageCard } from "./ai-triage-card";
import { GoalCompletionCard } from "./goal-completion-card";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";
import { useSharedAppState } from "@/state/app-state-context";
import { buildEvalsPath, navigateApp } from "@/lib/app-navigation";
import { ArrowUpDown } from "lucide-react";
import { getSidebarRunInsightsPassRateLabel } from "./run-header-compact-stats";
import { RunInsightsSidebarSummary } from "./run-insights-sidebar";
import { computeRunDashboardKpis } from "./run-detail-kpis";
import {
  caseListCardClassName,
} from "./case-list-shared";
import { RunCaseListWithSections } from "./run-case-list";
import type { RunCaseGroup } from "./run-case-groups";
import { groupRunIterationsByTestCase } from "./run-case-groups";
import { RunDetailKpiStrip } from "./run-detail-kpis";
import { ClientChip } from "@/components/clients/client-chip";
import {
  RunAccuracyHeroBand,
  RunInsightRail,
  shouldShowRunAccuracyHero,
  type RunTrendPoint,
} from "./run-insight-rail";
import { runDetailMetaLabelClass } from "./run-detail-typography";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

/** 3:2 default — test cases vs insight rail (option C). */
const RUN_DETAIL_CASES_PANEL_DEFAULT = 60;
const RUN_DETAIL_CASES_PANEL_MIN = 35;
const RUN_DETAIL_CASES_PANEL_MAX = 75;
const RUN_DETAIL_INSIGHTS_PANEL_MIN = 25;
const RUN_DETAIL_INSIGHTS_PANEL_MAX = 65;

const LG_MEDIA_QUERY = "(min-width: 1024px)";

function useLgUp(): boolean {
  const [lgUp, setLgUp] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia(LG_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(LG_MEDIA_QUERY);
    const onChange = () => {
      setLgUp(mql.matches);
    };
    mql.addEventListener("change", onChange);
    setLgUp(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return lgUp;
}

interface RunDetailViewProps {
  selectedRunDetails: EvalSuiteRun;
  caseGroupsForSelectedRun: EvalIteration[];
  source?: "ui" | "sdk";
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
  serverNames?: string[];
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  /** When set, highlights the grouped case row for this test case. */
  selectedTestCaseId?: string | null;
  /** Opens the run-scoped test case detail page (all iterations). */
  onSelectTestCase?: (group: RunCaseGroup) => void;
  hideCiMetadata?: boolean;
  /** When true, omit replay source line (shown in SuiteHeader instead). */
  hideReplayLineage?: boolean;
  /** When true, only the iteration detail pane is shown (list lives in a parent sidebar). */
  omitIterationList?: boolean;
  onOpenRunInsights?: () => void;
  runInsightsSelected?: boolean;
  /** Overrides default navigation to test-edit for iteration row edit actions. */
  onEditTestCase?: (testCaseId: string) => void;
  /** When true, every iteration with testCaseId shows the external-edit icon. */
  alwaysShowEditIterationRows?: boolean;
  /**
   * `header` = KPI cards are rendered in {@link SuiteHeader} (playground run detail).
   * `body` = KPI row stays in this view (CI / commit detail).
   */
  kpiPlacement?: "header" | "body";
  /**
   * Previous completed run offered as the deterministic diff base. Plumbed
   * through to {@link RunAccuracyHeroBand} for future re-surfacing; no
   * header UI consumes it today.
   */
  compareBaseRun?: EvalSuiteRun | null;
  onCompareWithRun?: (baseRunId: string) => void;
  /**
   * `namedHostId` → client display name. When the run was triggered against
   * a specific attached client (multi-client fan-out), the summary band
   * surfaces which client this run is for. Pass the suite's `hostAttachments`
   * map to feed it.
   */
  hostNamesById?: Map<string, string | null>;
  /** Recent run pass rates for the accuracy sparkline in the insight rail. */
  runTrendData?: RunTrendPoint[];
  /**
   * Navigate to another run on the accuracy hero's recent-run dot. Required for
   * CI/commit-detail callers so the jump stays on `/ci-evals/...` instead of
   * the default `buildEvalsPath` (`/evals/...`).
   */
  onSelectRun?: (runId: string) => void;
  /**
   * Current (live) suite judge config. Threaded into the goal-completion
   * card so older runs whose snapshot doesn't reflect the current toggle
   * state can still trigger a re-run when the suite is enabled today.
   * Optional — CI/commit-detail parents don't have a live suite handle.
   */
  currentSuiteJudgeConfig?: EvalJudgeConfig | null;
}

function runDetailSortLabel(sortBy: "model" | "test" | "result"): string {
  switch (sortBy) {
    case "model":
      return "Model";
    case "test":
      return "Test";
    case "result":
      return "Result";
    default:
      return sortBy;
  }
}

/** Iteration list + sort (composed inside run detail when the list is not inlined). */
export function RunIterationsSidebar({
  caseGroupsForSelectedRun,
  runDetailSortBy,
  onSortChange,
  selectedTestCaseId = null,
  onSelectTestCase,
  onEditTestCase: _onEditTestCase,
  runForOverview = null,
  runOverviewExtra = null,
  onOpenRunInsights,
  runInsightsSelected = false,
  alwaysShowEditIterationRows: _alwaysShowEditIterationRows = false,
  /**
   * When false, omit the “Overview” + pass rate row (main run detail already shows KPIs; list matches the suite “Cases” table + sort only).
   * CI run-detail sidebar keeps the default true for navigation back to run-level insights.
   */
  showRunOverviewNav = true,
  showCaseCardHeader = false,
}: {
  caseGroupsForSelectedRun: EvalIteration[];
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
  selectedTestCaseId?: string | null;
  onSelectTestCase?: (group: RunCaseGroup) => void;
  /** @deprecated Iteration-level selection moved to the test case detail page. */
  selectedIterationId?: string | null;
  /** @deprecated Use onSelectTestCase to open the run-scoped case detail page. */
  onSelectIteration?: (id: string) => void;
  onEditTestCase?: (testCaseId: string) => void;
  /** When set, shows run overview row above the iteration list (CI sidebar + inline run detail). */
  runForOverview?: EvalSuiteRun | null;
  /** Optional row below overview (e.g. link to full runs table). */
  runOverviewExtra?: ReactNode;
  /** Opens run-level insights in the main pane (no iteration). */
  onOpenRunInsights?: () => void;
  runInsightsSelected?: boolean;
  alwaysShowEditIterationRows?: boolean;
  showRunOverviewNav?: boolean;
  /** Card title above the grouped case table (playground run detail main column). */
  showCaseCardHeader?: boolean;
}) {
  const overviewStatsOverride = useMemo(() => {
    if (!runForOverview) return undefined;
    if (caseGroupsForSelectedRun.length === 0) {
      return (
        runForOverview.summary ?? {
          passed: 0,
          failed: 0,
          total: 0,
          passRate: 0,
        }
      );
    }
    const passed = caseGroupsForSelectedRun.filter((i) =>
      computeIterationPassed(i)
    ).length;
    const failed = caseGroupsForSelectedRun.filter(
      (i) => !computeIterationPassed(i)
    ).length;
    const total = caseGroupsForSelectedRun.length;
    const passRate = total > 0 ? passed / total : 0;
    return { passed, failed, total, passRate };
  }, [runForOverview, caseGroupsForSelectedRun]);

  const overviewPassRateLabel = useMemo(() => {
    if (!runForOverview) return null;
    return getSidebarRunInsightsPassRateLabel(
      runForOverview,
      overviewStatsOverride
    );
  }, [runForOverview, overviewStatsOverride]);

  const groupedCaseCount = useMemo(
    () =>
      groupRunIterationsByTestCase(
        caseGroupsForSelectedRun,
        runDetailSortBy,
      ).length,
    [caseGroupsForSelectedRun, runDetailSortBy],
  );

  const sortHeaderControl = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7 shrink-0 border-border/50 bg-background text-muted-foreground hover:text-foreground"
          aria-label={`Sort iterations: ${runDetailSortLabel(runDetailSortBy)}`}
          title={`Sort iterations: ${runDetailSortLabel(runDetailSortBy)}`}
        >
          <ArrowUpDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[8rem]">
        <DropdownMenuRadioGroup
          value={runDetailSortBy}
          onValueChange={(value) =>
            onSortChange(value as "model" | "test" | "result")
          }
        >
          <DropdownMenuRadioItem value="model" className="text-xs">
            {runDetailSortLabel("model")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="test" className="text-xs">
            {runDetailSortLabel("test")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="result" className="text-xs">
            {runDetailSortLabel("result")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {(showRunOverviewNav && runForOverview) || runOverviewExtra ? (
        <div className="shrink-0 border-b bg-muted/25">
          {showRunOverviewNav && runForOverview ? (
            <RunInsightsSidebarSummary
              onClick={onOpenRunInsights}
              selected={runInsightsSelected}
              trailing={overviewPassRateLabel}
            />
          ) : null}
          {runOverviewExtra ? (
            <div
              className={cn(
                showRunOverviewNav && runForOverview && "border-t",
                "px-4 pb-2 pt-2"
              )}
            >
              {runOverviewExtra}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            caseListCardClassName,
            "min-h-0 min-w-0 flex-1 overflow-hidden"
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto bg-muted/10 dark:bg-muted/15">
            <RunCaseListWithSections
              iterations={caseGroupsForSelectedRun}
              sortBy={runDetailSortBy}
              selectedTestCaseId={selectedTestCaseId}
              onSelectTestCase={(group) => {
                onSelectTestCase?.(group);
              }}
              caseCount={showCaseCardHeader ? groupedCaseCount : undefined}
              headerEnd={sortHeaderControl}
              trailingGutter={Boolean(_onEditTestCase)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function RunDetailView({
  selectedRunDetails,
  caseGroupsForSelectedRun,
  source,
  runDetailSortBy,
  onSortChange,
  serverNames: _serverNames = [],
  selectedIterationId,
  onSelectIteration,
  selectedTestCaseId = null,
  onSelectTestCase,
  hideCiMetadata,
  hideReplayLineage,
  omitIterationList = false,
  onOpenRunInsights,
  runInsightsSelected = false,
  onEditTestCase: onEditTestCaseProp,
  alwaysShowEditIterationRows = false,
  kpiPlacement = "body",
  compareBaseRun = null,
  onCompareWithRun,
  hostNamesById,
  runTrendData = [],
  onSelectRun,
  currentSuiteJudgeConfig,
}: RunDetailViewProps) {
  const handleEditTestCase =
    onEditTestCaseProp ??
    ((testCaseId: string) =>
      navigateApp(
        buildEvalsPath({
          type: "test-edit",
          suiteId: selectedRunDetails.suiteId,
          testId: testCaseId,
        })
      ));
  useRunInsights(selectedRunDetails, { autoRequest: true });

  const {
    result: serverQualityResult,
    pending: serverQualityPending,
    requested: serverQualityRequested,
    failedGeneration: serverQualityFailedGeneration,
    error: serverQualityError,
    requestServerQuality,
    unavailable: serverQualityUnavailable,
  } = useServerQuality(selectedRunDetails, { autoRequest: true });

  // Goal-completion judge: advisory, user-triggered (no auto-request — it spends
  // an LLM call). Never changes the run's deterministic pass/fail.
  // Scope the judge model catalog to the run's project org (same derivation as
  // useEvalTabContext) so hosted/BYOK orgs see the models they configured, not
  // just the managed defaults. Execution still runs on the managed key in V1.
  const appState = useSharedAppState();
  const judgeOrganizationId = useMemo(() => {
    const projectId =
      selectedRunDetails.projectId ?? appState.activeProjectId ?? null;
    return projectId
      ? (appState.projects?.[projectId]?.organizationId ?? null)
      : null;
  }, [
    selectedRunDetails.projectId,
    appState.activeProjectId,
    appState.projects,
  ]);
  const { availableModels } = useAvailableEvalModels(judgeOrganizationId);
  const {
    result: goalCompletionResult,
    pending: goalCompletionPending,
    requested: goalCompletionRequested,
    failedGeneration: goalCompletionFailedGeneration,
    error: goalCompletionError,
    requestGoalCompletion,
    unavailable: goalCompletionUnavailable,
  } = useGoalCompletion(selectedRunDetails);

  const runDashboardKpis = useMemo(
    () =>
      kpiPlacement === "body"
        ? computeRunDashboardKpis({
            selectedRunDetails,
            caseGroupsForSelectedRun,
            source,
          })
        : [],
    [kpiPlacement, selectedRunDetails, caseGroupsForSelectedRun, source]
  );

  const serverQualityTriage =
    selectedRunDetails.status === "completed" && !serverQualityUnavailable ? (
      <AiTriageCard
        run={selectedRunDetails}
        iterations={caseGroupsForSelectedRun}
        serverQuality={serverQualityResult ?? null}
        pending={serverQualityPending}
        requested={serverQualityRequested}
        failedGeneration={serverQualityFailedGeneration}
        error={serverQualityError}
        onRetry={() => requestServerQuality(true)}
        source={source}
      />
    ) : null;

  // Show the goal-completion panel once a run completes, unless the backend
  // mutation is unavailable (older deployment). The card itself gates on an
  // explicit "Run judge" click, so it never auto-spends an LLM call. Rendered
  // inside RunInsightRail next to the serverQuality triage card — the rail is
  // the run-detail "AI insights column" and goal-completion is an AI insight.
  const goalCompletionPanel =
    selectedRunDetails.status === "completed" && !goalCompletionUnavailable ? (
      <GoalCompletionCard
        // Remount per run so the model/threshold inputs reset to the new run's
        // settings instead of sticking from the previously viewed run.
        key={selectedRunDetails._id}
        run={selectedRunDetails}
        iterations={caseGroupsForSelectedRun}
        goalCompletion={goalCompletionResult ?? null}
        availableModels={availableModels}
        pending={goalCompletionPending}
        requested={goalCompletionRequested}
        failedGeneration={goalCompletionFailedGeneration}
        error={goalCompletionError}
        onRun={(args, force) => requestGoalCompletion(args, force)}
        currentSuiteJudgeConfig={currentSuiteJudgeConfig}
      />
    ) : null;

  const metricLabel = source === "sdk" ? "Pass rate" : "Accuracy";

  const showAccuracyHero = shouldShowRunAccuracyHero({
    run: selectedRunDetails,
    iterations: caseGroupsForSelectedRun,
    runTrendData,
  });

  const badgeMetricLabel = source === "sdk" ? "Pass Rate" : "Accuracy";

  const runClient = useMemo(() => {
    const hostId = selectedRunDetails.namedHostId;
    if (!hostId) return null;
    const displayName =
      hostNamesById?.get(hostId) ?? formatRunId(hostId);
    return { hostId, displayName };
  }, [selectedRunDetails.namedHostId, hostNamesById]);

  const accuracyHero = showAccuracyHero ? (
    <RunAccuracyHeroBand
      run={selectedRunDetails}
      iterations={caseGroupsForSelectedRun}
      compareBaseRun={compareBaseRun}
      runTrendData={runTrendData}
      metricLabel={metricLabel}
      badgeMetricLabel={badgeMetricLabel}
      includeRunIdentity
      hideReplayLineage={hideReplayLineage}
      runClient={runClient}
      onCompareWithRun={onCompareWithRun}
      onSelectRun={(runId) => {
        if (runId === selectedRunDetails._id) return;
        if (onSelectRun) {
          onSelectRun(runId);
          return;
        }
        navigateApp(
          buildEvalsPath({
            type: "run-detail",
            suiteId: selectedRunDetails.suiteId,
            runId,
          }),
        );
      }}
      className="mb-4"
    />
  ) : null;

  const insightRail = (
    <RunInsightRail
      triageCard={serverQualityTriage}
      goalCompletionCard={goalCompletionPanel}
    />
  );

  const runMetadataBlock = (
    <>
      {!hideCiMetadata &&
        (selectedRunDetails.ciMetadata?.branch ||
          selectedRunDetails.ciMetadata?.commitSha ||
          selectedRunDetails.ciMetadata?.runUrl) && (
          <div className="mb-4">
            <CiMetadataDisplay ciMetadata={selectedRunDetails.ciMetadata} />
          </div>
        )}

      {runClient && !showAccuracyHero ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className={runDetailMetaLabelClass}>Client</span>
          <ClientChip
            name={runClient.displayName}
            hostId={runClient.hostId}
          />
        </div>
      ) : null}

      {!hideReplayLineage && selectedRunDetails.replayedFromRunId ? (
        <p
          className="mb-4 text-xs text-muted-foreground"
          title={selectedRunDetails.replayedFromRunId}
        >
          Replay of{" "}
          <span className="font-mono text-foreground/90">
            Run {formatRunId(selectedRunDetails.replayedFromRunId)}
          </span>
        </p>
      ) : null}

    </>
  );

  const bodyKpiStrip =
    kpiPlacement === "body" && runDashboardKpis.length > 0 ? (
      <div className="mb-4 shrink-0">
        <RunDetailKpiStrip kpis={runDashboardKpis} />
      </div>
    ) : null;

  const stackedInsightsBody = (
    <div className="space-y-4">
      {bodyKpiStrip}
      {accuracyHero}
      {insightRail}
    </div>
  );

  const useTwoColumnLayout = !omitIterationList;
  const lgUp = useLgUp();

  const iterationsSidebar = (
    <RunIterationsSidebar
      caseGroupsForSelectedRun={caseGroupsForSelectedRun}
      runDetailSortBy={runDetailSortBy}
      onSortChange={onSortChange}
      selectedTestCaseId={selectedTestCaseId}
      onSelectTestCase={onSelectTestCase}
      selectedIterationId={selectedIterationId}
      onSelectIteration={onSelectIteration}
      runForOverview={selectedRunDetails}
      onEditTestCase={handleEditTestCase}
      onOpenRunInsights={onOpenRunInsights}
      runInsightsSelected={runInsightsSelected}
      alwaysShowEditIterationRows={alwaysShowEditIterationRows}
      showRunOverviewNav={false}
      showCaseCardHeader
    />
  );

  return (
    <div
      className={cn(
        "relative flex min-h-0 w-full min-w-0 flex-1 flex-col",
        useTwoColumnLayout ? "overflow-hidden p-4" : "overflow-y-auto p-4",
        omitIterationList && "px-3 py-3",
      )}
    >
      <div className="shrink-0">{runMetadataBlock}</div>

      {useTwoColumnLayout ? (
        <>
          {bodyKpiStrip}
          {accuracyHero}
          {lgUp ? (
            <ResizablePanelGroup
              direction="horizontal"
              autoSaveId="evals-run-detail-cases-insights"
              className="min-h-0 min-w-0 flex-1"
            >
              <ResizablePanel
                defaultSize={RUN_DETAIL_CASES_PANEL_DEFAULT}
                minSize={RUN_DETAIL_CASES_PANEL_MIN}
                maxSize={RUN_DETAIL_CASES_PANEL_MAX}
                className="flex min-h-0 min-w-0 flex-col overflow-hidden"
              >
                {iterationsSidebar}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                defaultSize={100 - RUN_DETAIL_CASES_PANEL_DEFAULT}
                minSize={RUN_DETAIL_INSIGHTS_PANEL_MIN}
                maxSize={RUN_DETAIL_INSIGHTS_PANEL_MAX}
                className="flex min-h-0 min-w-0 flex-col overflow-hidden"
              >
                <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                  {insightRail}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
              <div className="flex min-h-[240px] min-w-0 flex-col overflow-hidden">
                {iterationsSidebar}
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {insightRail}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="shrink-0">{stackedInsightsBody}</div>
      )}
    </div>
  );
}
