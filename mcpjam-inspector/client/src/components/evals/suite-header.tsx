import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  ChevronDown,
  Code2,
  GitBranch,
  Loader2,
  PanelLeft,
  Play,
  Plus,
  RotateCw,
  Settings,
  Sparkles,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { buildEvalsPath, navigateApp } from "@/lib/app-navigation";
import { track } from "@/lib/analytics";
import {
  formatRunId,
  getEffectiveSuiteServers,
  getRunMetricSource,
} from "./helpers";
import { SuiteRevisionPill } from "./suite-revision-pill";
import {
  EvalSuite,
  EvalSuiteRun,
  EvalIteration,
  EvalCase,
  SuiteAggregate,
} from "./types";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { CiMetadataDisplay } from "./ci-metadata-display";
import { GenerateCasesConfigPopover } from "./generate-cases-config-popover";
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { ValidatorsSection } from "./validators-section";
import {
  resolveMatchOptions,
  type EvalMatchOptions,
} from "@/shared/eval-matching";
import { RunHeaderCompactStats } from "./run-header-compact-stats";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { getSuiteReplayEligibility } from "./replay-eligibility";
import { RunDetailPlaygroundActions } from "./run-detail-playground-actions";
import { cn } from "@/lib/utils";
import { countSuiteRunPlans } from "./helpers";
import { SuiteRunCostEstimateHint } from "./run-cost-estimate-hint";
import { SuiteRunDisclosureHint } from "./run-disclosure-hint";
import type { SuiteOverviewView } from "@/lib/eval-route-types";

interface SuiteHeaderProps {
  suite: EvalSuite;
  viewMode: "overview" | "run-detail" | "test-detail" | "test-edit";
  selectedRunDetails: EvalSuiteRun | null;
  isEditMode: boolean;
  onRerun: (
    suite: EvalSuite,
    opts?: {
      matchOptionsOverride?: EvalMatchOptions;
      iterationOverride?: number;
      refreshSnapshot?: boolean;
    }
  ) => void;
  onReplayRun?: (suite: EvalSuite, run: EvalSuiteRun) => void;
  onCancelRun: (runId: string) => void;
  onViewModeChange: (mode: "overview") => void;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  replayingRunId?: string | null;
  cancellingRunId: string | null;
  runsViewMode?: SuiteOverviewView;
  runs?: EvalSuiteRun[];
  allIterations?: EvalIteration[];
  aggregate?: SuiteAggregate | null;
  testCases?: EvalCase[];
  readOnlyConfig?: boolean;
  hideRunActions?: boolean;
  onSetupCi?: () => void;
  onOpenExportSuite?: () => void;
  /**
   * Playground: suite overview uses {@link SuiteDashboard} for both runs and cases, but the
   * URL can still be `?view=runs`. When true, show manual case actions whenever we are in
   * suite overview, not only when the legacy tab is `?view=test-cases`.
   */
  unifiedSuiteDashboard?: boolean;
  /** When the parent hides the cases sidebar (e.g. Explore run insights landing). */
  casesSidebarHidden?: boolean;
  onShowCasesSidebar?: () => void;
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  generateTestCasesDisabledReason?: string;
  evalRunsDisabledReason?: string | null;
  isGeneratingTestCases?: boolean;
  onCreateTestCase?: () => void;
  /** Per-case runs from the test cases list / sidebar; not shown in the suite header. */
  onRunTestCase?: (testCase: EvalCase) => void;
  /** When true, per-case runs (row play + header run-first) are disabled. */
  blockTestCaseRuns?: boolean;
  /**
   * Playground: block suite-level Run all while a single case quick-run is in flight.
   */
  runningTestCaseId?: string | null;
  /** Playground run detail: compact KPI strip rendered beside the run title. */
  runDetailKpiStrip?: ReactNode;
  /**
   * When true, run title / badge / stats live in {@link RunAccuracyHeroBand};
   * this header row is actions-only.
   */
  omitRunDetailIdentity?: boolean;
  /**
   * Transient per-run iteration count (1-10). Applied to both Run-all-cases
   * and per-case runs triggered from this suite view; does NOT mutate the
   * persisted `EvalCase.runs` defaults.
   */
  iterationOverride?: number;
  onIterationOverrideChange?: (value: number | undefined) => void;
  /**
   * Open the settings-history slide-over.
   *
   * Optional, and the revision pill still RENDERS without it: the number is
   * the useful half — which version of these settings am I looking at — and
   * withholding it because the drill-down is unavailable takes the answer away
   * along with the panel.
   */
  onOpenRevisionHistory?: () => void;
}

export function SuiteHeader(props: SuiteHeaderProps) {
  const {
    suite,
    viewMode,
    selectedRunDetails,
    isEditMode,
    onRerun,
    onReplayRun,
    onCancelRun,
    onViewModeChange,
    iterationOverride,
    onIterationOverrideChange,
    connectedServerNames,
    rerunningSuiteId,
    replayingRunId = null,
    cancellingRunId,
    runs = [],
    testCases = [],
    readOnlyConfig = false,
    hideRunActions = false,
    onSetupCi,
    onOpenExportSuite,
    unifiedSuiteDashboard = false,
    casesSidebarHidden = false,
    onShowCasesSidebar,
    onGenerateTestCases,
    canGenerateTestCases = false,
    generateTestCasesDisabledReason,
    // Effective reason, derived by the PARENT (suite-iterations-view) — it
    // owns every run control, so the cloud-sandbox preflight is folded in
    // there, not here (deriving here left the per-case buttons ungated).
    evalRunsDisabledReason = null,
    isGeneratingTestCases = false,
    onCreateTestCase,
    blockTestCaseRuns: _blockTestCaseRuns = false,
    runningTestCaseId = null,
    runsViewMode = "runs",
    runDetailKpiStrip,
    omitRunDetailIdentity = false,
    onOpenRevisionHistory,
  } = props;

  const showTestCaseCtas =
    runsViewMode === "test-cases" ||
    (unifiedSuiteDashboard && viewMode === "overview");

  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(suite.name);
  const [runMatchOptionsOverride, setRunMatchOptionsOverride] = useState<
    EvalMatchOptions | undefined
  >(undefined);
  const updateSuite = useMutation("testSuites:updateTestSuite" as any);

  const latestRunForMetadata = useMemo(() => {
    if (!runs || runs.length === 0) return null;
    return [...runs].sort((a, b) => {
      const aTime = a.completedAt ?? a.createdAt ?? 0;
      const bTime = b.completedAt ?? b.createdAt ?? 0;
      return bTime - aTime;
    })[0];
  }, [runs]);
  const latestRunIsInProgress =
    latestRunForMetadata?.status === "running" ||
    latestRunForMetadata?.status === "pending";

  useEffect(() => {
    setEditedName(suite.name);
  }, [suite.name]);

  const handleNameClick = useCallback(() => {
    setIsEditingName(true);
    setEditedName(suite.name);
  }, [suite.name]);

  const handleNameBlur = useCallback(async () => {
    setIsEditingName(false);
    if (editedName && editedName.trim() && editedName !== suite.name) {
      try {
        await updateSuite({
          suiteId: suite._id,
          name: editedName.trim(),
        });
        toast.success("Suite name updated");
      } catch (error) {
        toast.error(
          getBillingErrorMessage(error, "Failed to update suite name")
        );
        console.error("Failed to update suite name:", error);
        setEditedName(suite.name);
      }
    } else {
      setEditedName(suite.name);
    }
  }, [editedName, suite.name, suite._id, updateSuite]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleNameBlur();
      } else if (e.key === "Escape") {
        setIsEditingName(false);
        setEditedName(suite.name);
      }
    },
    [handleNameBlur, suite.name]
  );

  // Calculate suite server status from the EFFECTIVE server list —
  // legacy `environment.servers` merged with any host attachments'
  // resolvedServerNames. Without the merge, attachment-only suites
  // (the current model) read as empty and Run all stayed disabled
  // with "Configure suite servers" forever.
  const suiteServers = getEffectiveSuiteServers(suite);
  const replayEligibility = getSuiteReplayEligibility({
    suiteServers,
    connectedServerNames,
    latestRun: latestRunForMetadata,
  });
  const { hasServersConfigured, missingServers } = replayEligibility;
  const canTriggerLiveRun = hasServersConfigured;
  const isRerunning =
    rerunningSuiteId === suite._id || latestRunIsInProgress;
  const replayableLatestRun = replayEligibility.replayableLatestRun;
  const isReplayingLatestRun =
    replayableLatestRun != null && replayingRunId === replayableLatestRun._id;

  if (isEditMode) {
    // Settings sheet header — matches the body's max-w-2xl column so the
    // title sits flush over the form. Title is light-weight (semibold,
    // not text-xl bold) so the eyebrow-labelled sections below carry the
    // visual rhythm.
    return (
      <div className="mb-1 flex w-full max-w-2xl items-center justify-between gap-4 px-6 pt-8 mx-auto min-w-0">
        {/* READ-ONLY in the settings sheet. Renaming lives in the sheet's own
            Name row now, and leaving the inline editor here too gave one field
            two writers: this one commits on blur, immediately, with no review,
            no note and no revision precondition. Using it while a draft held an
            unsaved name marked the sheet as "changed elsewhere" for the
            person's own action, and the next save overwrote the rename with the
            stale draft. */}
        <div className="min-w-0 flex-1 pr-2">
          <h1
            className="truncate text-lg font-semibold tracking-tight"
            title={suite.name}
          >
            {suite.name}
          </h1>
        </div>
        {/* WHAT VERSION AM I LOOKING AT, not "am I finished".
            The Done button told a reader this sheet was a form to fill in and
            submit, which it has not been since the draft-and-commit bar
            shipped: Done only navigated, and the save lives in the bar. The
            breadcrumb is the way back. What belongs in this corner is the
            thing a reader of a shared suite actually needs — which revision
            these settings are, and who moved them last. */}
        <SuiteRevisionPill
          revisionNumber={suite.revisionNumber}
          onOpenHistory={() => onOpenRevisionHistory?.()}
        />
      </div>
    );
  }

  if (viewMode === "run-detail" && selectedRunDetails) {
    const badgeMetricLabel =
      getRunMetricSource(selectedRunDetails, suite.source) === "sdk"
        ? "Pass Rate"
        : "Accuracy";

    if (omitRunDetailIdentity) {
      if (hideRunActions) {
        // Playground: suite chrome stays pinned; run identity lives in the body.
      } else {
        return (
          <div className="mb-4 flex min-w-0 justify-end">
            <RunDetailPlaygroundActions
              suite={suite}
              selectedRun={selectedRunDetails}
              readOnlyConfig={readOnlyConfig}
              onReplayRun={onReplayRun}
              onRerun={onRerun}
              onCancelRun={onCancelRun}
              rerunningSuiteId={rerunningSuiteId}
              replayingRunId={replayingRunId}
              cancellingRunId={cancellingRunId}
              hasServersConfigured={hasServersConfigured}
              missingServers={missingServers}
              runsDisabledReason={evalRunsDisabledReason}
              showCloseButton
              onBackToOverview={() => onViewModeChange("overview")}
            />
          </div>
        );
      }
    } else {
      return (
        <div
          className={cn(
            "mb-4 flex min-w-0",
            runDetailKpiStrip
              ? "flex-nowrap items-center gap-3"
              : "flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-1",
              runDetailKpiStrip ? "shrink-0" : "flex-1"
            )}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-lg font-semibold tracking-tight">
                Run {formatRunId(selectedRunDetails._id)}
              </h2>
              <PassCriteriaBadge
                run={selectedRunDetails}
                variant="compact"
                metricLabel={badgeMetricLabel}
              />
              {selectedRunDetails.replayedFromRunId ? (
                <span
                  className="text-xs text-muted-foreground"
                  title={selectedRunDetails.replayedFromRunId}
                >
                  Replay of{" "}
                  <span className="font-mono text-foreground/80">
                    Run {formatRunId(selectedRunDetails.replayedFromRunId)}
                  </span>
                </span>
              ) : null}
            </div>
            {runDetailKpiStrip ? null : (
              <RunHeaderCompactStats run={selectedRunDetails} />
            )}
          </div>
          {runDetailKpiStrip ? (
            <div className="min-w-0 flex-1 self-center">{runDetailKpiStrip}</div>
          ) : null}
          {!hideRunActions ? (
            <div className={cn("shrink-0", !runDetailKpiStrip && "sm:pt-0.5")}>
              <RunDetailPlaygroundActions
                suite={suite}
                selectedRun={selectedRunDetails}
                readOnlyConfig={readOnlyConfig}
                onReplayRun={onReplayRun}
                onRerun={onRerun}
                onCancelRun={onCancelRun}
                rerunningSuiteId={rerunningSuiteId}
                replayingRunId={replayingRunId}
                cancellingRunId={cancellingRunId}
                hasServersConfigured={hasServersConfigured}
                missingServers={missingServers}
                runsDisabledReason={evalRunsDisabledReason}
                showCloseButton
                onBackToOverview={() => onViewModeChange("overview")}
              />
            </div>
          ) : null}
        </div>
      );
    }
  }

  if (viewMode === "test-detail" || viewMode === "test-edit") {
    return null;
  }

  const overviewRunAllCta =
    hideRunActions && showTestCaseCtas
      ? (() => {
          const testCaseCount = testCases?.length ?? 0;
          // Environment suites launch through the server's authoritative
          // resolution — `handleRerunSuite` skips the local server gate for
          // them (`!isEnvironmentSuite && suiteServers.length === 0`), so the
          // browser never needs to know their closed server set. Requiring
          // local servers here made Run all unclickable for an env-only suite.
          const isEnvironmentSuite = (suite.environmentIds?.length ?? 0) > 0;
          const runAllNeedsLocalServers =
            !isEnvironmentSuite && !hasServersConfigured;
          const isRunAllDisabled = Boolean(
            isRerunning ||
              replayingRunId != null ||
              runningTestCaseId != null ||
              evalRunsDisabledReason ||
              testCaseCount === 0 ||
              runAllNeedsLocalServers
          );
          const runAllDisabledReasonTooltip = evalRunsDisabledReason
            ? evalRunsDisabledReason
            : runAllNeedsLocalServers
            ? "Configure suite servers before running the full suite."
            : testCaseCount === 0
            ? "Add a test case first."
            : isRerunning || replayingRunId != null
            ? "A suite or replay is already in progress."
            : runningTestCaseId != null
            ? "Finish the in-progress test case run first."
            : null;
          // `missingServers` compares the LOCAL server list against connected
          // ones. An environment suite launches against the server-side resolved
          // set instead, so a disconnected legacy entry says nothing about
          // whether its run can proceed — and now that env suites are runnable,
          // showing "Connect and run." for them would be actively misleading.
          const runAllConnectionHint =
            !isEnvironmentSuite && missingServers.length > 0
              ? "Connect and run."
              : null;
          const hasRunOverride =
            (runMatchOptionsOverride &&
              Object.keys(runMatchOptionsOverride).length > 0) ||
            iterationOverride !== undefined;
          const runAllButton = (
            <div className="inline-flex items-center">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-8 gap-1.5 rounded-r-none"
                disabled={isRunAllDisabled}
                aria-label="Run all cases in this suite"
                aria-busy={isRerunning}
                onClick={() => {
                  track("run_all_cases_button_clicked", {
                    location: "suite_header",
                    suite_id: suite._id,
                    iteration_override: iterationOverride ?? null,
                  });
                  onRerun(suite, {
                    ...(runMatchOptionsOverride
                      ? { matchOptionsOverride: runMatchOptionsOverride }
                      : {}),
                    ...(iterationOverride !== undefined
                      ? { iterationOverride }
                      : {}),
                  });
                }}
              >
                {isRerunning ? (
                  <Loader2
                    className="h-3.5 w-3.5 shrink-0 animate-spin"
                    aria-hidden
                  />
                ) : (
                  <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                Run all
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    disabled={isRerunning}
                    aria-label="Configure next run"
                    title="Configure next run"
                    className="relative h-8 w-7 rounded-l-none border-l border-primary-foreground/30 px-0"
                  >
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    {hasRunOverride ? (
                      <span
                        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-orange-400"
                        aria-hidden
                      />
                    ) : null}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[22rem] space-y-3 p-3" align="end">
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    These settings apply to the <strong>next run only</strong>.
                    To change the suite&apos;s defaults, open Suite settings.
                  </p>
                  {onIterationOverrideChange ? (
                    <div className="flex items-center justify-between gap-3">
                      <label
                        htmlFor="run-all-iterations"
                        className="text-xs font-medium text-foreground"
                      >
                        Iterations
                      </label>
                      <select
                        id="run-all-iterations"
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                        value={iterationOverride ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value;
                          onIterationOverrideChange(
                            raw === "" ? undefined : Number(raw)
                          );
                        }}
                        aria-label="Iterations per test case for the next run"
                      >
                        <option value="">Auto</option>
                        {Array.from({ length: 10 }, (_, i) => i + 1).map(
                          (n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  ) : null}
                  <ValidatorsSection
                    title="Matchers"
                    density="compact"
                    value={runMatchOptionsOverride}
                    inheritedFrom={resolveMatchOptions(
                      suite.defaultMatchOptions
                    )}
                    onChange={setRunMatchOptionsOverride}
                    showBadges
                    hideInheritedBadge
                  />
                </PopoverContent>
              </Popover>
            </div>
          );
          const runAllControl =
            isRunAllDisabled && runAllDisabledReasonTooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">{runAllButton}</span>
                </TooltipTrigger>
                <TooltipContent
                  variant="muted"
                  side="bottom"
                  className="max-w-[16rem]"
                >
                  {runAllDisabledReasonTooltip}
                </TooltipContent>
              </Tooltip>
            ) : !isRunAllDisabled && runAllConnectionHint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">{runAllButton}</span>
                </TooltipTrigger>
                <TooltipContent
                  variant="muted"
                  side="bottom"
                  className="max-w-[16rem]"
                >
                  {runAllConnectionHint}
                </TooltipContent>
              </Tooltip>
            ) : (
              runAllButton
            );
          // The estimate rides BESIDE the CTA (never inside its disabled
          // tooltip trigger) so it stays readable whether or not Run all is
          // currently runnable, and it never gates the run. `countSuiteRunPlans`
          // is the same fan-out width `buildSuiteRunPlans` produces; the hint
          // renders nothing — and fetches nothing — when the flag is off.
          return (
            <span className="inline-flex items-center gap-1.5">
              {runAllControl}
              <SuiteRunCostEstimateHint
                suiteId={suite._id}
                planCount={countSuiteRunPlans(suite)}
                environmentIds={suite.environmentIds}
                // Structural blockers only: with no cases there is nothing to
                // price, and with no servers configured Run all can never
                // launch. The transient blockers (a rerun/replay in flight, a
                // case running, an entitlement block) keep the estimate — it
                // stays accurate for the run that follows.
                suppressed={testCaseCount === 0 || runAllNeedsLocalServers}
                {...(iterationOverride !== undefined
                  ? { iterationOverride }
                  : {})}
              />
              <SuiteRunDisclosureHint
                suiteId={suite._id}
                environmentIds={suite.environmentIds}
                // The host axis applies only when no environments are
                // attached (the environment axis always wins when both are —
                // same rule `computeRunTargets` uses). The hint decides from
                // the COUNT: exactly one attached host is disclosed for real
                // since G4c, several is the multi-target refusal.
                hostIds={(suite.hostAttachments ?? []).map(
                  (attachment) => attachment.namedHostId
                )}
                suppressed={testCaseCount === 0 || runAllNeedsLocalServers}
              />
            </span>
          );
        })()
      : null;

  const overviewHasSuiteNav =
    (casesSidebarHidden &&
      Boolean(onShowCasesSidebar) &&
      runsViewMode === "runs") ||
    Boolean(onSetupCi && !readOnlyConfig);

  const overviewHasCaseTools =
    overviewRunAllCta != null ||
    (showTestCaseCtas && Boolean(onGenerateTestCases)) ||
    (showTestCaseCtas && Boolean(onCreateTestCase));

  const overviewSuiteNavButtons =
    overviewHasSuiteNav ? (
      <>
        {casesSidebarHidden && onShowCasesSidebar && runsViewMode === "runs" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={onShowCasesSidebar}
          >
            <PanelLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Cases
          </Button>
        ) : null}
        {onSetupCi && !readOnlyConfig ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={onSetupCi}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Setup CI
          </Button>
        ) : null}
      </>
    ) : null;

  const overviewSettingsButton =
    !readOnlyConfig && !isEditMode ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            aria-label="Suite settings"
            onClick={() =>
              navigateApp(
                buildEvalsPath({
                  type: "suite-edit",
                  suiteId: suite._id,
                }),
              )
            }
          >
            <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          variant="muted"
          side="bottom"
          align="end"
          sideOffset={6}
          className="px-2 py-1 text-[11px]"
        >
          Suite settings — where it runs, validators, judges
        </TooltipContent>
      </Tooltip>
    ) : null;

  const overviewGenerateButton =
    showTestCaseCtas && onGenerateTestCases ? (
      <div className="inline-flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-r-none"
                onClick={onGenerateTestCases}
                disabled={!canGenerateTestCases || isGeneratingTestCases}
                aria-busy={isGeneratingTestCases}
              >
                {isGeneratingTestCases ? (
                  <Loader2
                    className="h-3.5 w-3.5 shrink-0 animate-spin"
                    aria-hidden
                  />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                Generate
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent
            variant="muted"
            side="bottom"
            align="start"
            sideOffset={8}
            className="max-w-[min(17rem,calc(100vw-1.5rem))] px-3 py-2 text-left font-normal leading-relaxed"
          >
            {isGeneratingTestCases
              ? "Generating test cases…"
              : !canGenerateTestCases
                ? (generateTestCasesDisabledReason ??
                  "Configure suite servers before generating cases.")
                : "Generate suggested cases from your server's tools. Use the arrow to set how many and what kind."}
          </TooltipContent>
        </Tooltip>
        <GenerateCasesConfigPopover
          suiteId={suite._id}
          onGenerate={onGenerateTestCases}
          disabled={!canGenerateTestCases}
          isGenerating={isGeneratingTestCases}
          disabledReason={generateTestCasesDisabledReason}
        />
      </div>
    ) : null;

  const overviewNewCaseButton =
    showTestCaseCtas && onCreateTestCase ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5"
        onClick={onCreateTestCase}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
        New case
      </Button>
    ) : null;

  const overviewSetupSdkButton = onOpenExportSuite ? (
    <Button
      size="sm"
      variant="outline"
      className="h-8 gap-1.5"
      onClick={onOpenExportSuite}
    >
      <Code2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
      Setup SDK
    </Button>
  ) : null;

  const overviewLegacyRunActions =
    !hideRunActions && (replayableLatestRun || !readOnlyConfig) ? (
      <>
        {!readOnlyConfig && hasServersConfigured ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-muted-foreground"
                  disabled={Boolean(isRerunning || evalRunsDisabledReason)}
                  onClick={() => onRerun(suite, { refreshSnapshot: true })}
                >
                  <RotateCw
                    className={`h-3.5 w-3.5 shrink-0 ${
                      isRerunning ? "animate-spin" : ""
                    }`}
                    aria-hidden
                  />
                  Update snapshot
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent
              variant="muted"
              side="bottom"
              className="max-w-[16rem]"
            >
              {evalRunsDisabledReason ??
                "Re-saves the suite's current server list as the frozen execution snapshot and starts a run."}
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() =>
                  replayableLatestRun
                    ? onReplayRun?.(suite, replayableLatestRun)
                    : onRerun(suite, {
                        ...(runMatchOptionsOverride
                          ? { matchOptionsOverride: runMatchOptionsOverride }
                          : {}),
                        ...(iterationOverride !== undefined
                          ? { iterationOverride }
                          : {}),
                      })
                }
                disabled={
                  replayableLatestRun
                    ? isReplayingLatestRun ||
                      !onReplayRun ||
                      Boolean(evalRunsDisabledReason)
                    : !canTriggerLiveRun ||
                      isRerunning ||
                      Boolean(evalRunsDisabledReason)
                }
              >
                <RotateCw
                  className={`h-3.5 w-3.5 shrink-0 ${
                    (replayableLatestRun ? isReplayingLatestRun : isRerunning)
                      ? "animate-spin"
                      : ""
                  }`}
                  aria-hidden
                />
                {(replayableLatestRun ? isReplayingLatestRun : isRerunning)
                  ? replayableLatestRun
                    ? "Replaying..."
                    : "Running..."
                  : replayableLatestRun
                    ? "Replay latest run"
                    : "Run"}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {replayableLatestRun
              ? evalRunsDisabledReason
                ? evalRunsDisabledReason
                : "Replay the latest CI run"
              : evalRunsDisabledReason
                ? evalRunsDisabledReason
                : !hasServersConfigured
                  ? "No MCP servers are configured for this suite"
                  : missingServers.length > 0
                    ? "Connect and run."
                    : "Run all cases"}
          </TooltipContent>
        </Tooltip>
      </>
    ) : null;

  const overviewHasRightActions =
    overviewHasCaseTools ||
    Boolean(overviewSetupSdkButton) ||
    Boolean(overviewLegacyRunActions);

  return (
    <div
      data-testid="suite-overview-header"
      className="mb-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 max-w-[20rem] shrink overflow-hidden sm:max-w-md">
          <div className="flex min-w-0 items-center gap-2">
            {isEditingName ? (
              <input
                type="text"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={handleNameKeyDown}
                autoFocus
                className="h-8 min-w-0 w-full max-w-full flex-1 rounded-md border border-input px-3 py-0 text-base font-semibold leading-none focus:outline-none focus:ring-2 focus:ring-ring md:text-lg"
              />
            ) : readOnlyConfig ? (
              <h2
                className="flex h-8 min-w-0 flex-1 items-center truncate px-2 text-base font-semibold leading-none md:text-lg"
                title={suite.name}
              >
                {suite.name}
              </h2>
            ) : (
              <Button
                variant="ghost"
                onClick={handleNameClick}
                className="h-8 min-w-0 max-w-full flex-1 justify-start gap-0 px-2 text-left text-base font-semibold leading-none hover:bg-accent md:text-lg"
                title={suite.name}
              >
                <span className="min-w-0 truncate text-left">{suite.name}</span>
              </Button>
            )}
            {latestRunForMetadata ? (
              <span className="shrink-0">
                <CiMetadataDisplay
                  ciMetadata={latestRunForMetadata.ciMetadata}
                  compact={true}
                />
              </span>
            ) : null}
          </div>
        </div>
        {overviewSettingsButton}
        {overviewSuiteNavButtons}
      </div>
      {overviewHasRightActions ? (
        <div
          data-testid="suite-overview-actions"
          className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2"
        >
          {overviewSetupSdkButton}
          {overviewLegacyRunActions}
          {overviewGenerateButton}
          {overviewNewCaseButton}
          {overviewRunAllCta}
        </div>
      ) : null}
    </div>
  );
}
