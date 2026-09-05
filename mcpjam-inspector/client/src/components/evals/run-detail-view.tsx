import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import { ActionableFindings } from "@/components/shared/actionable-insights/actionable-findings";
import { formatRunId } from "./helpers";
import {
  buildOpenAiSubmissionReport,
  renderOpenAiSubmissionReport,
} from "@/lib/evals/openai-submission-report";
import { buildSubmissionCasesFromRun } from "./run-submission";
import { computeIterationPassed } from "./pass-criteria";
import { EvalIteration, EvalJudgeConfig, EvalSuiteRun } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { ImportEvidenceCard } from "./import-evidence-card";
import { useRunImportEligibility } from "./use-run-import-eligibility";
import { useRunInsights } from "./use-run-insights";
import { useServerQuality } from "./use-server-quality";
import { useGoalCompletion } from "./use-goal-completion";
import { useGroundedness } from "./use-groundedness";
import { GroundednessCard } from "./groundedness-card";
import { AiTriageCard } from "./ai-triage-card";
import {
  computeRunPassRatePercent,
  unifyTriageRows,
} from "./ai-triage-helpers";
import { GoalCompletionCard } from "./goal-completion-card";
import {
  buildJudgeCaseMap,
  caseKeyForGroup,
  deterministicCasePassed,
  judgeDisagreesWithVerdict,
  type JudgeCase,
} from "./goal-completion-presentation";
import { RunInsightBand, type InsightSeverity } from "./run-insight-band";
import {
  SuiteRunStageFunnelAvailability,
  SuiteRunStageFunnelPanel,
} from "@/components/shared/user-value-chain/StageFunnelPanels";
import {
  RunUserValueChainSlot,
  useRunUserValueChainChoice,
} from "./run-user-value-chain-slot";
import {
  RunLevelFindingsLine,
  StageFindingsCard,
} from "@/components/evaluate/stage-findings-card";
import { useStageFindings } from "@/components/evaluate/use-stage-findings";
import { ExplanatoryFlowOptIn } from "@/components/shared/usage-insights/ExplanatoryFlowOptIn";
import type { InsightsScope } from "@/hooks/useUsageInsights";
import { useAvailableModels } from "@/hooks/use-available-models";
import { buildEvalsPath, navigateApp } from "@/lib/app-navigation";
import { ArrowUpDown, Download, Share2 } from "lucide-react";
import { getSidebarRunInsightsPassRateLabel } from "./run-header-compact-stats";
import { RunInsightsSidebarSummary } from "./run-insights-sidebar";
import { computeRunDashboardKpis } from "./run-detail-kpis";
import { caseListCardClassName } from "./case-list-shared";
import { RunCaseListWithSections } from "./run-case-list";
import type { RunCaseGroup } from "./run-case-groups";
import { groupRunIterationsByTestCase } from "./run-case-groups";
import { RunDetailKpiStrip } from "./run-detail-kpis";
import { HostChip } from "@/components/hosts/host-chip";
import {
  RunAccuracyHeroBand,
  RunInsightRail,
  runHasInsightContent,
  shouldShowRunAccuracyHero,
  type RunTrendPoint,
} from "./run-insight-rail";
import { runDetailMetaLabelClass } from "./run-detail-typography";
import { RunPluginSnapshot } from "./run-plugin-snapshot";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

/** 3:2 default — test cases vs insight rail (option C). */
const RUN_DETAIL_CASES_PANEL_DEFAULT = 58;
const RUN_DETAIL_CASES_PANEL_MIN = 35;
const RUN_DETAIL_CASES_PANEL_MAX = 72;
const RUN_DETAIL_INSIGHTS_PANEL_MIN = 28;
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
  /**
   * When true, hide the "Recent runs" chip strip in the accuracy hero — used
   * when an external run switcher (the suite results rail) already lists runs.
   */
  hideRecentRuns?: boolean;
  /**
   * Replaces the built-in per-iteration case table. The unified suite results
   * surface passes the scoped cross-host matrix here so the run view's table
   * matches the All-runs / group tables (one shared case×host idiom).
   */
  caseTableSlot?: React.ReactNode;
  /**
   * Suppress the run's own KPI cards / accuracy hero. Used when the run is
   * folded into the results split, where the shared suite metric strip (scoped
   * to this run) already owns that real estate — avoids a duplicate band.
   */
  hideKpiStrip?: boolean;
  hideAccuracyHero?: boolean;
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
  /** Opens the OTLP trace-export modal for this run (rendered on the hero band). */
  onExportTraces?: () => void;
  /**
   * Opens the share dialog. Owned by run-detail parents (not CI-embedded
   * views). Widens the action-row guard so plugin-free runs still render
   * the row when sharing is available.
   */
  onShare?: () => void;
  /**
   * Navigate to another run on the accuracy hero's recent-run dot. Required for
   * CI/commit-detail callers so the jump stays on `/evals/runs/...` instead of
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
  /**
   * The run's own canonical decision summary, as a slot.
   *
   * A SLOT rather than a fetch, because this view is shared: `/evals`, the CI
   * commit detail and Evaluate all mount it, and only Evaluate opts into the
   * D9 read. Passing the rendered node keeps the opt-in at the call site and
   * keeps every non-Evaluate mount at exactly zero summary requests.
   */
  decisionSummarySlot?: React.ReactNode;
  /**
   * Join D9's per-trial diagnostics onto the canonical stage document.
   *
   * A BOOLEAN rather than a slot, unlike `decisionSummarySlot` above, because
   * the evidence hangs off individual stage cards this view mounts — there is
   * no single node a caller could hand in. The zero-request guarantee is kept
   * the same way `RunDecisionSummarySection` keeps it: off by default, and a
   * disabled read issues no request at all, so `/evals` and the CI commit
   * detail stay at exactly zero.
   */
  stageFindingsEnabled?: boolean;
  /**
   * Focus one trial's evidence through the app's own routing.
   *
   * Same shape and same contract as the decision card's `onViewTrace`: called
   * only with identities verified against the run on screen, and with the CASE
   * the iteration belongs to, because that is what the viewer can open to.
   */
  onViewStageTrace?: (target: {
    runId: string;
    iterationId: string;
    testCaseId: string;
  }) => void;
  /**
   * The cohort the flow diagram would analyze, when this surface has one.
   *
   * A prop rather than something derived here, for the reason the funnel below
   * it is not: the funnel reads a rollup that already exists for any run, and
   * the diagram needs a cohort a paid analyzer pass can be filed against. Only
   * a caller knows whether this run belongs to one. `null` (the default) means
   * no cohort, and the panel renders nothing rather than offering a button
   * that would spend nothing.
   */
  flowScope?: InsightsScope | null;
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
  flushChrome = false,
  judgeByCaseKey,
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
  /** Flush layout inside the run-detail split (no nested card chrome). */
  flushChrome?: boolean;
  /** Advisory judge verdicts by snapshot caseKey; rows show a badge when set. */
  judgeByCaseKey?: Map<string, JudgeCase> | null;
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
    // B3b W4: `computeIterationPassed` now reads a row's STORED result when it
    // has one, so this override no longer re-runs the tool-call matcher in the
    // browser to second-guess a verdict the server already reached — which at
    // grading mode `enforce` was reached from gating evidence (predicates,
    // gates, tool errors) the browser cannot see at all. The matcher survives
    // inside that helper for rows with no stored result; see its docblock.
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
      groupRunIterationsByTestCase(caseGroupsForSelectedRun, runDetailSortBy)
        .length,
    [caseGroupsForSelectedRun, runDetailSortBy]
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
            flushChrome
              ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card"
              : caseListCardClassName,
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
              judgeByCaseKey={judgeByCaseKey}
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
  hideRecentRuns = false,
  caseTableSlot,
  hideKpiStrip = false,
  hideAccuracyHero = false,
  onExportTraces,
  onShare,
  decisionSummarySlot,
  stageFindingsEnabled = false,
  onViewStageTrace,
  flowScope = null,
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

  // The run's own eligibility, from the canonical single-run query. The list
  // projection this screen's `selectedRunDetails` usually comes from does not
  // carry one, so reading it off that object would render every converted run
  // as though it had no imported cases.
  const { eligibility: runImportEligibility } = useRunImportEligibility(
    selectedRunDetails._id,
  );

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
  // Scope the judge model catalog to the run's project org (the hook falls
  // back to the active project) so hosted/BYOK orgs see the models they
  // configured, not just the managed defaults. Execution still runs on the
  // managed key in V1.
  const { availableModels } = useAvailableModels({
    projectId: selectedRunDetails.projectId ?? null,
  });

  // The frozen reproducible-env pin this run launched from (if any). Resolve a
  // friendly name best-effort; fall back to the snapshot's environmentId if the
  // environment was deleted since the run.
  const runComputerEnv = selectedRunDetails.configSnapshot?.computerEnvironment;
  // Durable id keyed off the frozen pin, falling back to the snapshot's
  // environment.computerEnvironmentId — so a run that recorded the id without
  // the newer frozen object still shows an Environment row.
  const runComputerEnvId =
    runComputerEnv?.environmentId ??
    selectedRunDetails.configSnapshot?.environment?.computerEnvironmentId ??
    null;
  const runEnvironments = useSandboxImages(
    runComputerEnvId ? selectedRunDetails.projectId ?? null : null
  );
  // Friendly name when resolvable; otherwise the RAW id (never truncated — it's
  // the only durable identifier once the environment is deleted).
  const runComputerEnvLabel = runComputerEnvId
    ? runEnvironments?.find((e) => e.environmentId === runComputerEnvId)
        ?.name ?? runComputerEnvId
    : null;
  // Project-environment provenance frozen at run start (name + revision) —
  // renders the "Environment" chip. Distinct from the sandbox-image pin
  // above, whose chip reads "Sandbox image". Flag-gated so the rollback
  // kill-switch hides env names/revisions on retained historical runs too.
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const runProjectEnvironmentRef = projectEnvironmentsEnabled
    ? selectedRunDetails.configSnapshot?.environmentRef ?? null
    : null;
  // OpenAI submission evidence (INS-5). Offered only when the run pinned a
  // plugin: the document's value is naming the exact bundle it is evidence
  // about, which a plugin-free run cannot do.
  const pluginSubmissionVersions =
    selectedRunDetails.configSnapshot?.environmentPluginVersions ?? [];
  const downloadSubmissionReport = useCallback(() => {
    const report = buildOpenAiSubmissionReport({
      // The run row carries no suite NAME (CI/commit-detail parents have no
      // live suite handle), so title the document by suite id rather than
      // guessing a name that might not be the suite's.
      suiteName: `Suite ${formatRunId(selectedRunDetails.suiteId)}`,
      runLabel: `Run ${formatRunId(selectedRunDetails._id)} (#${
        selectedRunDetails.runNumber
      })`,
      cases: buildSubmissionCasesFromRun(caseGroupsForSelectedRun),
      pluginVersions: pluginSubmissionVersions.map((version) => ({
        name: version.name,
        pluginVersionId: version.pluginVersionId,
        bundleHash: version.bundleHash,
      })),
      skillsExcluded: selectedRunDetails.configSnapshot?.skillsExcluded,
    });
    const blob = new Blob([renderOpenAiSubmissionReport(report)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchorEl = document.createElement("a");
    anchorEl.href = url;
    anchorEl.download = `openai-submission-${formatRunId(
      selectedRunDetails._id
    )}.md`;
    anchorEl.click();
    URL.revokeObjectURL(url);
  }, [
    caseGroupsForSelectedRun,
    pluginSubmissionVersions,
    selectedRunDetails._id,
    selectedRunDetails.configSnapshot?.skillsExcluded,
    selectedRunDetails.runNumber,
    selectedRunDetails.suiteId,
  ]);

  const {
    result: goalCompletionResult,
    pending: goalCompletionPending,
    requested: goalCompletionRequested,
    failedGeneration: goalCompletionFailedGeneration,
    error: goalCompletionError,
    requestGoalCompletion,
    unavailable: goalCompletionUnavailable,
  } = useGoalCompletion(selectedRunDetails);

  const {
    result: groundednessResult,
    pending: groundednessPending,
    requested: groundednessRequested,
    failedGeneration: groundednessFailedGeneration,
    error: groundednessError,
    requestGroundedness,
    unavailable: groundednessUnavailable,
  } = useGroundedness(selectedRunDetails);

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

  const embeddedInResultsSplit = hideKpiStrip;

  /**
   * Whether this run has a stage funnel to draw, reported by the probe below.
   *
   * Stored WITH the run it describes, and read only when that run is the one
   * on screen. This component is reused across runs by the run selector, so a
   * bare boolean would survive a switch and a stale `true` would open an empty
   * rail on the run you moved to. Starting empty also means a run without a
   * funnel never flashes one on the way to finding out.
   */
  const [stageFunnelFor, setStageFunnelFor] = useState<{
    suiteRunId: string | undefined;
    hasFunnel: boolean;
  }>({ suiteRunId: undefined, hasFunnel: false });

  const handleStageFunnelAvailability = useCallback(
    (suiteRunId: string | undefined, hasFunnel: boolean) =>
      setStageFunnelFor({ suiteRunId, hasFunnel }),
    [],
  );

  const legacyStageFunnel =
    stageFunnelFor.suiteRunId === selectedRunDetails._id &&
    stageFunnelFor.hasFunnel;

  /**
   * What the chain slot will actually draw — resolved HERE, once, and handed
   * both to the rail's emptiness check and to the slot itself.
   *
   * One call, not two. The rail has to know whether to open before it mounts
   * what it would open around, and the slot needs the same answer to render;
   * but this hook wraps a plain `fetch` rather than a Convex subscription, so
   * calling it in both places would issue two HTTP requests per run with
   * nothing de-duplicating them.
   */
  const runChain = useRunUserValueChainChoice({
    projectId: selectedRunDetails.projectId ?? null,
    runId: selectedRunDetails._id,
    // A run opened while it is still going has no document yet. Passing the
    // status lets the read happen again once it finishes, instead of the
    // too-early "no document" answer standing until this view remounts.
    runStatus: selectedRunDetails.status,
  });

  /**
   * The trial evidence behind the canonical document's stage failures.
   *
   * Called unconditionally — hooks must be — but INERT unless the caller opted
   * in: `enabled: false` makes the underlying decision-summary read issue no
   * request, so the non-Evaluate mounts of this shared view stay at zero. When
   * it is on, the read shares the LRU store with `RunDecisionSummarySection`'s
   * identical target, so the two callers are one request.
   */
  const stageFindings = useStageFindings({
    projectId: selectedRunDetails.projectId ?? null,
    analytics: runChain.document,
    run: selectedRunDetails,
    enabled: stageFindingsEnabled,
    canOpenTrial: Boolean(onViewStageTrace),
  });

  /**
   * Either reading counts as content — but only the one the slot will draw.
   *
   * The probe below answers only for the LEGACY rollup, so on a run with a
   * canonical document and no rollup it reports "no funnel" and would close a
   * rail over content that is there.
   */
  const hasStageFunnel =
    runChain.choice === "canonical" ||
    (runChain.choice === "legacy" && legacyStageFunnel) ||
    // A canonical read that really FAILED is content too. Without this, a run
    // with no legacy rollup and no other insight card closes the rail over the
    // service note written specifically to report that failure — the one case
    // where the message is the only thing there is to say.
    runChain.serviceNote !== null;

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
        hostNamesById={hostNamesById}
        embedded={embeddedInResultsSplit}
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
        embedded={embeddedInResultsSplit}
      />
    ) : null;

  // Advisory judge verdicts by snapshot caseKey — surfaced inline on each case
  // row (next to the deterministic pass/fail) so the judge isn't buried in the
  // side card. Null when nothing is graded, which skips badge rendering.
  const judgeByCaseKey = useMemo(
    () => buildJudgeCaseMap(goalCompletionResult),
    [goalCompletionResult]
  );

  // Run-level judge headline for the collapsed insight band (the per-case detail
  // now lives in the matrix cells). meet-goal count + how many cases the judge
  // disagrees with the deterministic pass/fail on (the actionable signal).
  const judgeHeadline = useMemo(() => {
    const cases = goalCompletionResult?.cases ?? [];
    if (cases.length === 0) return null;
    const meet = cases.filter((c) => c.passed).length;
    const deterministicByCaseKey = new Map<string, boolean | null>();
    for (const group of groupRunIterationsByTestCase(
      caseGroupsForSelectedRun,
      "test"
    )) {
      const key = caseKeyForGroup(group);
      if (key) deterministicByCaseKey.set(key, deterministicCasePassed(group));
    }
    const disagreements = cases.filter((c) =>
      judgeDisagreesWithVerdict(
        deterministicByCaseKey.get(c.caseKey) ?? null,
        c.passed
      )
    ).length;
    return { meet, total: cases.length, disagreements };
  }, [goalCompletionResult, caseGroupsForSelectedRun]);

  // Progressive discovery: the band stays neutral (muted) unless there's
  // something worth a click — a judge disagreement or a quality flag → amber;
  // the worst quality findings (poor tool / excessive workflow) → red.
  const insightSeverity: InsightSeverity = useMemo(() => {
    const sq = serverQualityResult;
    const hasAlert =
      sq?.toolInsights?.some((t) => t.rating === "poor") ||
      sq?.workflowInsights?.some((w) => w.efficiency === "excessive");
    if (hasAlert) return "alert";
    const hasWarn =
      (judgeHeadline?.disagreements ?? 0) > 0 ||
      sq?.toolInsights?.some((t) => t.rating === "needs_improvement") ||
      sq?.workflowInsights?.some((w) => w.efficiency === "inefficient");
    return hasWarn ? "warn" : "neutral";
  }, [judgeHeadline, serverQualityResult]);

  const metricLabel = source === "sdk" ? "Pass rate" : "Accuracy";

  const showAccuracyHero =
    !hideAccuracyHero &&
    shouldShowRunAccuracyHero({
      run: selectedRunDetails,
      iterations: caseGroupsForSelectedRun,
      runTrendData,
    });

  const badgeMetricLabel = source === "sdk" ? "Pass Rate" : "Accuracy";

  const runClient = useMemo(() => {
    const hostId = selectedRunDetails.namedHostId;
    if (!hostId) return null;
    const displayName = hostNamesById?.get(hostId) ?? formatRunId(hostId);
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
      hideRecentRuns={hideRecentRuns}
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
          })
        );
      }}
      className="mb-4"
    />
  ) : null;

  // Second named judge, same gating discipline as goal completion: shown once
  // the run completes, never auto-spends, hidden against an older backend.
  const groundednessPanel =
    selectedRunDetails.status === "completed" && !groundednessUnavailable ? (
      <GroundednessCard
        key={`groundedness-${selectedRunDetails._id}`}
        run={selectedRunDetails}
        groundedness={groundednessResult ?? null}
        pending={groundednessPending}
        requested={groundednessRequested}
        failedGeneration={groundednessFailedGeneration}
        error={groundednessError}
        onRun={(force) => requestGroundedness(force)}
      />
    ) : null;

  // The same actionable findings the swarm and user-testing surfaces render,
  // projected from THIS run's serverQuality by the backend. It sits above the
  // existing triage card rather than replacing it: triage is per-tool
  // reference, this is the ordered list of what to change.
  //
  // Rendered only for a COMPLETED run, and only when serverQuality is
  // available: on this surface `AiTriageCard` already owns the pending /
  // failed / unavailable states for the very same generation, so letting the
  // panel narrate them too would double every status line. The other two
  // surfaces have no such sibling and do show them.
  const actionableFindingsPanel =
    selectedRunDetails.status === "completed" &&
    !serverQualityUnavailable &&
    selectedRunDetails._id ? (
      <div className="mb-3 rounded-lg border border-border/50 bg-card/40 empty:hidden">
        <ActionableFindings
          boundaryName="eval-actionable-findings"
          surface={{
            kind: "eval_run",
            suiteRunId: String(selectedRunDetails._id),
          }}
          context={{ rerunLabel: "this eval suite" }}
        />
      </div>
    ) : null;

  /**
   * The free half and the paid half of the same traces, side by side.
   *
   * The funnel is mounted unconditionally because reading it costs nothing —
   * the stage worker already derived those verdicts, and this is their rollup.
   * The diagram beside it is a model's reading, bought per pass, and issues no
   * query at all until somebody clicks. Auto-requesting it would put a charge
   * on opening a tab.
   *
   * A fragment rather than a wrapper: each half suppresses itself when it has
   * nothing, and a wrapping div would survive both of them to leave a padded
   * empty box — and, in the embedded rail, a divider with nothing under it.
   */
  const userValueChainPanel = (
    <>
      {/* Canonical document or legacy rollup, never both — the slot decides.
          Flag-off is today's page exactly: the legacy panel, unlabelled. */}
      <RunUserValueChainSlot
        chain={runChain}
        className="m-3"
        renderFindings={(stage) => (
          <StageFindingsCard
            state={stageFindings}
            stage={stage}
            {...(onViewStageTrace ? { onOpenTrial: onViewStageTrace } : {})}
          />
        )}
        runLevelFindings={<RunLevelFindingsLine state={stageFindings} />}
        legacy={
          <SuiteRunStageFunnelPanel
            suiteRunId={selectedRunDetails._id}
            className="m-3"
          />
        }
      />
      <ExplanatoryFlowOptIn scope={flowScope} className="m-3" />
    </>
  );

  /**
   * Mounted unconditionally, and deliberately NOT inside the rail or the band
   * it informs — it answers whether those should open, so it has to exist
   * before they do. Renders nothing; costs one query, which Convex shares with
   * the panel's own subscription.
   */
  const stageFunnelProbe = (
    <SuiteRunStageFunnelAvailability
      suiteRunId={selectedRunDetails._id}
      onChange={handleStageFunnelAvailability}
    />
  );

  const insightRail = (
    <RunInsightRail
      triageCard={
        actionableFindingsPanel ? (
          <>
            {actionableFindingsPanel}
            {serverQualityTriage}
          </>
        ) : (
          serverQualityTriage
        )
      }
      goalCompletionCard={goalCompletionPanel}
      groundednessCard={groundednessPanel}
      userValueChainCard={userValueChainPanel}
      userValueChainHasContent={hasStageFunnel}
      embedded={embeddedInResultsSplit}
    />
  );

  /**
   * The chain counts toward "is there anything to show" — but only when it
   * actually has a funnel to draw.
   *
   * Both gates below read this ONE boolean, and it comes from a probe rather
   * than from the panel, because the panel cannot answer: neither gate mounts
   * it until they have already decided to open. Counting the card itself
   * instead would keep a rail alive on every run with no insight content at
   * all, since the node is truthy whether or not it renders anything — which
   * is why it was excluded from these checks in the first place, and why the
   * fix has to be data-driven rather than a matter of adding the node.
   */
  const hasInsightContent = runHasInsightContent({
    serverQualityTriage,
    goalCompletionPanel,
    groundednessPanel,
    actionableFindingsPanel,
    hasStageFunnel,
  });

  const triageFixCount = useMemo(
    () =>
      unifyTriageRows({
        serverQuality: serverQualityResult ?? null,
        iterations: caseGroupsForSelectedRun,
      }).length,
    [serverQualityResult, caseGroupsForSelectedRun]
  );

  const bandPassRatePercent = useMemo(() => {
    if (!hideAccuracyHero) return null;
    return computeRunPassRatePercent({
      selectedRunDetails,
      caseGroupsForSelectedRun,
    });
  }, [hideAccuracyHero, selectedRunDetails, caseGroupsForSelectedRun]);

  // Collapsed summary for the run-level band (replaces the side rail in the
  // embedded results view). Lead with the actionable signal; secondary line is
  // context (pass rate, judge headline) the user can ignore until they expand.
  const insightBandSummary = useMemo(() => {
    const metricWord = metricLabel.toLowerCase();
    const primary = (() => {
      if (triageFixCount > 0) {
        return `${triageFixCount} suggested fix${
          triageFixCount === 1 ? "" : "es"
        }`;
      }
      if ((judgeHeadline?.disagreements ?? 0) > 0) {
        const n = judgeHeadline!.disagreements;
        return `${n} judge disagreement${n === 1 ? "" : "s"}`;
      }
      if (judgeHeadline) {
        return `Judge ${judgeHeadline.meet}/${judgeHeadline.total} meet goal`;
      }
      return "Run insights";
    })();

    const secondaryParts: string[] = [];
    if (bandPassRatePercent !== null) {
      secondaryParts.push(`${bandPassRatePercent}% ${metricWord}`);
    }
    if (judgeHeadline && triageFixCount > 0) {
      if (judgeHeadline.disagreements > 0) {
        secondaryParts.push(
          `${judgeHeadline.disagreements} judge disagreement${
            judgeHeadline.disagreements === 1 ? "" : "s"
          }`
        );
      } else {
        secondaryParts.push(
          `Judge ${judgeHeadline.meet}/${judgeHeadline.total} meet goal`
        );
      }
    } else if (
      judgeHeadline &&
      triageFixCount === 0 &&
      judgeHeadline.disagreements === 0
    ) {
      secondaryParts.push(
        `${judgeHeadline.meet}/${judgeHeadline.total} meet goal`
      );
    }

    return (
      <>
        <span className="font-medium text-foreground">{primary}</span>
        {secondaryParts.length > 0 ? (
          <span className="truncate text-xs text-muted-foreground">
            {secondaryParts.join(" · ")}
          </span>
        ) : null}
      </>
    );
  }, [bandPassRatePercent, judgeHeadline, metricLabel, triageFixCount]);

  const insightBand = hasInsightContent ? (
    <RunInsightBand summary={insightBandSummary} severity={insightSeverity}>
      <div className="max-h-[55vh] overflow-y-auto">{insightRail}</div>
    </RunInsightBand>
  ) : null;

  const runMetadataBlock = (
    <>
      {/* FROZEN import evidence, from the run's own snapshot.
          Fetched canonically rather than derived from the suite's current
          cases: those get edited after runs finish, and recomputing would let
          an edit rewrite what a finished run is shown to have decided. */}
      <ImportEvidenceCard eligibility={runImportEligibility} className="mb-4" />

      {!hideCiMetadata &&
        (selectedRunDetails.ciMetadata?.branch ||
          selectedRunDetails.ciMetadata?.commitSha ||
          selectedRunDetails.ciMetadata?.runUrl) && (
          <div className="mb-4">
            <CiMetadataDisplay ciMetadata={selectedRunDetails.ciMetadata} />
          </div>
        )}

      {/* Run IDENTITY, in precedence order. When the run launched from a
          project environment, the ENVIRONMENT is what produced it — the host
          below is a detail of how the environment resolved, not the run's
          identity. Two environments can resolve to the same host, so the host
          alone cannot name the run. `rev N` is the exact revision THIS run
          pinned; grouping elsewhere keys on the environment id, never this. */}
      {runProjectEnvironmentRef ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className={runDetailMetaLabelClass}>Environment</span>
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs"
            title={runProjectEnvironmentRef.environmentId}
          >
            <span className="text-foreground">
              {runProjectEnvironmentRef.name}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              rev {runProjectEnvironmentRef.revision}
            </span>
          </span>
        </div>
      ) : null}

      {/* The plugin surface, directly under the environment that pinned it:
          a plugin reaches a run only through an environment, so the two are
          one fact read top to bottom. Renders nothing when no plugin was
          pinned. */}
      <RunPluginSnapshot
        pluginVersions={
          selectedRunDetails.configSnapshot?.environmentPluginVersions
        }
        skillsExcluded={selectedRunDetails.configSnapshot?.skillsExcluded}
      />

      {runClient && !showAccuracyHero && !embeddedInResultsSplit ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className={runDetailMetaLabelClass}>Client</span>
          <HostChip name={runClient.displayName} hostId={runClient.hostId} />
        </div>
      ) : null}

      {runComputerEnvId ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* "Sandbox image", not "Environment" — project environments own
              that word now (naming decision 2026-07-24). */}
          <span className={runDetailMetaLabelClass}>Sandbox image</span>
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs"
            title={
              runComputerEnv
                ? `Image ${runComputerEnv.e2bTemplateId}${
                    runComputerEnv.baseImageDigests[0]
                      ? ` · ${runComputerEnv.baseImageDigests[0]}`
                      : ""
                  } · ${runComputerEnv.provider}`
                : undefined
            }
          >
            <span className="text-foreground">{runComputerEnvLabel}</span>
            {runComputerEnv ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                {runComputerEnv.provider}
              </span>
            ) : null}
          </span>
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
    !hideKpiStrip && kpiPlacement === "body" && runDashboardKpis.length > 0 ? (
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
      flushChrome={embeddedInResultsSplit}
      judgeByCaseKey={judgeByCaseKey}
    />
  );

  // The unified results surface injects the shared cross-host matrix here so the
  // run view's table matches All-runs / group; otherwise use the built-in
  // per-iteration list (standalone run-detail page).
  const caseTable = caseTableSlot ?? iterationsSidebar;

  return (
    <div
      className={cn(
        "relative flex min-h-0 w-full min-w-0 flex-1 flex-col",
        useTwoColumnLayout
          ? cn("overflow-hidden", embeddedInResultsSplit ? "p-0" : "p-4")
          : "overflow-y-auto p-4",
        omitIterationList && "px-3 py-3"
      )}
    >
      {/* Renders nothing. Sits above every layout branch below because all of
          them gate on the answer it reports. */}
      {stageFunnelProbe}
      {onExportTraces || pluginSubmissionVersions.length > 0 || onShare ? (
        // Always-on run-level actions — placed here (not the accuracy hero) so
        // they survive the folded run-detail layout that hides the hero.
        <div className="mb-3 flex shrink-0 justify-end gap-2">
          {onShare ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onShare}
              className="gap-1.5"
              data-testid="run-detail-share"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
          ) : null}
          {pluginSubmissionVersions.length > 0 ? (
            // Offered only for a run that pinned a plugin. The document's
            // entire value is naming the bundle it is evidence about, so on a
            // plugin-free run there is nothing to submit and no button.
            <Button
              variant="outline"
              size="sm"
              onClick={downloadSubmissionReport}
              className="gap-1.5"
              data-testid="run-detail-openai-submission"
            >
              <Download className="h-3.5 w-3.5" />
              Submission report
            </Button>
          ) : null}
          {onExportTraces ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onExportTraces}
              className="gap-1.5"
              data-testid="run-detail-export-traces"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* The run's own answer, above the browser's derived KPIs: what the run
          DECIDED comes before how its trials went. Absent (and unfetched) on
          every surface that does not pass the slot. */}
      {decisionSummarySlot ? (
        <div className="shrink-0">{decisionSummarySlot}</div>
      ) : null}

      <div className="shrink-0" data-testid="run-detail-metadata">
        {runMetadataBlock}
      </div>

      {useTwoColumnLayout ? (
        <>
          {bodyKpiStrip}
          {accuracyHero}
          {embeddedInResultsSplit ? (
            // Sidebar dissolved: per-case insight lives in the matrix cells,
            // run-level summary collapses into the band above a full-width
            // matrix. (Standalone run-detail keeps the side rail below.)
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {insightBand}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {caseTable}
              </div>
            </div>
          ) : lgUp ? (
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
                {caseTable}
              </ResizablePanel>
              <ResizableHandle
                withHandle={!embeddedInResultsSplit}
                className={cn(
                  embeddedInResultsSplit &&
                    "w-px bg-border/60 after:w-0 [&>div]:hidden"
                )}
              />
              <ResizablePanel
                defaultSize={100 - RUN_DETAIL_CASES_PANEL_DEFAULT}
                minSize={RUN_DETAIL_INSIGHTS_PANEL_MIN}
                maxSize={RUN_DETAIL_INSIGHTS_PANEL_MAX}
                className="flex min-h-0 min-w-[17.5rem] flex-col overflow-hidden bg-card"
              >
                <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                  {insightRail}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
              <div className="flex min-h-[240px] min-w-0 flex-col overflow-hidden">
                {caseTable}
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
