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
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { buildEvalsPath, navigateApp } from "@/lib/app-navigation";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { formatRunId, getEffectiveSuiteServers } from "./helpers";
import {
  EvalSuite,
  EvalSuiteRun,
  EvalIteration,
  EvalCase,
  SuiteAggregate,
} from "./types";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { isMCPJamProvidedModel } from "@/shared/types";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { ValidatorsSection } from "./validators-section";
import {
  resolveMatchOptions,
  type EvalMatchOptions,
} from "@/shared/eval-matching";
import { RunHeaderCompactStats } from "./run-header-compact-stats";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { getSuiteReplayEligibility } from "./replay-eligibility";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { RunDetailPlaygroundActions } from "./run-detail-playground-actions";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { SuiteOverviewClientBar } from "./suite-overview-client-bar";
import type { HostAttachmentDraft } from "./client-attachments-editor";
import type { HostListItem } from "@/hooks/useClients";
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
  /** Persists the suite's host attachments (multi-host fan-out target list). */
  onSuiteHostAttachmentsUpdate?: (
    attachments: HostAttachmentDraft[]
  ) => Promise<void>;
  /** Hosts available to attach (from `useHostList`). Optional for legacy callers. */
  projectHosts?: HostListItem[];
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
    evalRunsDisabledReason = null,
    isGeneratingTestCases = false,
    onCreateTestCase,
    blockTestCaseRuns: _blockTestCaseRuns = false,
    runningTestCaseId = null,
    runsViewMode = "runs",
    onSuiteHostAttachmentsUpdate,
    projectHosts = [],
    runDetailKpiStrip,
    omitRunDetailIdentity = false,
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

  const handleServerAttachmentUpdate = useCallback(
    async (serverAttachmentId: string) => {
      // Picker calls this synchronously inside onClick — don't rethrow,
      // or the unawaited promise becomes an unhandled rejection. The
      // toast is the user-facing signal; the suite row will reconcile
      // from the live Convex subscription on retry.
      try {
        await updateSuite({
          suiteId: suite._id,
          serverAttachmentId,
        });
        posthog.capture("eval_suite_server_changed", {
          location: "suite_header",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suite._id,
          server_attachment_id: serverAttachmentId,
        });
        toast.success("Server attachment updated");
      } catch (error) {
        toast.error(
          getBillingErrorMessage(error, "Failed to update server attachment")
        );
      }
    },
    [suite._id, updateSuite]
  );

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
  const isRerunning = rerunningSuiteId === suite._id;
  const replayableLatestRun = replayEligibility.replayableLatestRun;
  const isReplayingLatestRun =
    replayableLatestRun != null && replayingRunId === replayableLatestRun._id;

  // Check which provider API keys are missing for replay
  const { hasToken } = useAiProviderKeys();
  const missingReplayProviderKeys = useMemo(() => {
    if (!replayableLatestRun || !testCases || testCases.length === 0) return [];
    const providers = new Set<string>();
    for (const tc of testCases) {
      for (const m of tc.models ?? []) {
        if (!isMCPJamProvidedModel(m.model, m.provider)) {
          providers.add(m.provider);
        }
      }
    }
    return [...providers].filter(
      (p) => !hasToken(p.toLowerCase() as keyof ProviderTokens)
    );
  }, [replayableLatestRun, testCases, hasToken]);

  const isMobile = useIsMobile();

  if (isEditMode) {
    // Settings sheet header — matches the body's max-w-2xl column so the
    // title sits flush over the form. Title is light-weight (semibold,
    // not text-xl bold) so the eyebrow-labelled sections below carry the
    // visual rhythm; Done is a ghost chip, not a heavy outline button.
    return (
      <div className="mb-1 flex w-full max-w-2xl items-center justify-between gap-4 px-6 pt-8 mx-auto min-w-0">
        <div className="min-w-0 flex-1 pr-2">
          {isEditingName && !readOnlyConfig ? (
            <input
              type="text"
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              autoFocus
              className="w-full min-w-0 max-w-full -ml-2 px-2 py-1 text-lg font-semibold border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-background"
            />
          ) : readOnlyConfig ? (
            <h1
              className="truncate text-lg font-semibold tracking-tight"
              title={suite.name}
            >
              {suite.name}
            </h1>
          ) : (
            <Button
              variant="ghost"
              onClick={handleNameClick}
              className="h-auto max-w-full min-w-0 justify-start -ml-2 rounded-md px-2 py-1 text-left text-lg font-semibold tracking-tight hover:bg-accent/40"
              title={suite.name}
            >
              <span className="min-w-0 truncate text-left">{suite.name}</span>
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => onViewModeChange("overview")}
        >
          Done
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  if (viewMode === "run-detail" && selectedRunDetails) {
    const badgeMetricLabel = suite.source === "sdk" ? "Pass Rate" : "Accuracy";

    if (omitRunDetailIdentity) {
      return hideRunActions ? null : (
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
            showCloseButton
            onBackToOverview={() => onViewModeChange("overview")}
          />
        </div>
      );
    }

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
              showCloseButton
              onBackToOverview={() => onViewModeChange("overview")}
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (viewMode === "test-detail" || viewMode === "test-edit") {
    return null;
  }

  // Hosts bar is rendered whenever the suite overview is visible, regardless
  // of whether any cases exist yet — the empty "Attach host" affordance is
  // the whole point of surfacing the axis up front. The model-axis bar was
  // removed: a host's `modelId` is the source of truth for what each run
  // runs against, so a separate suite-wide model selector is just noise.
  const suiteOverviewHostBar = (
    <SuiteOverviewClientBar
      containerVariant="inline"
      className="py-1.5 md:py-2"
      suite={suite}
      projectHosts={projectHosts}
      readOnly={readOnlyConfig}
      onUpdate={onSuiteHostAttachmentsUpdate}
      onUpdateServerAttachment={handleServerAttachmentUpdate}
    />
  );

  const overviewRunAllCta =
    hideRunActions && showTestCaseCtas
      ? (() => {
          const testCaseCount = testCases?.length ?? 0;
          const isRunAllDisabled = Boolean(
            isRerunning ||
              replayingRunId != null ||
              runningTestCaseId != null ||
              evalRunsDisabledReason ||
              testCaseCount === 0 ||
              !hasServersConfigured
          );
          const runAllDisabledReasonTooltip = evalRunsDisabledReason
            ? evalRunsDisabledReason
            : !hasServersConfigured
            ? "Configure suite servers before running the full suite."
            : testCaseCount === 0
            ? "Add a test case first."
            : isRerunning || replayingRunId != null
            ? "A suite or replay is already in progress."
            : runningTestCaseId != null
            ? "Finish the in-progress test case run first."
            : null;
          const runAllConnectionHint =
            missingServers.length > 0 ? "Connect and run." : null;
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
                  posthog.capture("run_all_cases_button_clicked", {
                    location: "suite_header",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
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
          if (isRunAllDisabled && runAllDisabledReasonTooltip) {
            return (
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
            );
          }
          if (!isRunAllDisabled && runAllConnectionHint) {
            return (
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
            );
          }
          return runAllButton;
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
  const overviewHasExportOrRun =
    Boolean(onOpenExportSuite) ||
    (!hideRunActions && (replayableLatestRun || !readOnlyConfig));

  return (
    <div
      className={cn(
        "mb-4 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2",
        "md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-x-5 md:gap-y-2"
      )}
    >
      <div className="row-start-1 col-start-1 min-w-0 overflow-hidden">
        <div className="flex min-w-0 items-center gap-3">
          {isEditingName ? (
            <input
              type="text"
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              autoFocus
              className="min-w-0 w-full max-w-full flex-1 rounded-md border border-input px-3 text-base font-semibold leading-none focus:outline-none focus:ring-2 focus:ring-ring md:text-lg h-8 py-0"
            />
          ) : readOnlyConfig ? (
            <h2
              className="min-w-0 flex-1 truncate px-2 text-base font-semibold leading-none md:text-lg flex h-8 items-center"
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
      {isMobile ? (
        <div className="row-start-2 col-span-2 min-w-0">
          {suiteOverviewHostBar}
        </div>
      ) : null}
      <div className="row-start-1 col-start-2 flex min-w-0 max-w-full shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {!isMobile ? (
          <div className="min-w-0 max-w-full shrink">
            {suiteOverviewHostBar}
          </div>
        ) : null}
        {overviewHasSuiteNav ? (
          <div className="flex items-center gap-2">
            {casesSidebarHidden &&
            onShowCasesSidebar &&
            runsViewMode === "runs" ? (
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
          </div>
        ) : null}

        {/* Gear into the suite-edit page (description / pass-fail /
            validators / judges). Rendered in its OWN block — NOT inside
            `overviewHasSuiteNav` — because that predicate only fires when
            the cases-sidebar toggle or Setup CI is shown. Without its own
            block the gear was invisible on every standard suite-overview
            (the case the goal-completion CTA explicitly points at).
            The route + handler plumbing existed since the suite-edit view
            shipped but no UI surface invoked it — existing suites were
            only reachable via the URL bar. Hidden in edit mode (would be
            a self-link) and when the suite is read-only. */}
        {!readOnlyConfig && !isEditMode ? (
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
                    })
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
              Suite settings — description, validators, judges
            </TooltipContent>
          </Tooltip>
        ) : null}

        {overviewHasCaseTools ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-l border-border/40 pl-3">
            {overviewRunAllCta}
            {showTestCaseCtas && onGenerateTestCases ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
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
                        <Sparkles
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden
                        />
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
                    ? generateTestCasesDisabledReason ??
                      "Configure suite servers before generating cases."
                    : "Generate suggested cases from your server's tools."}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {showTestCaseCtas && onCreateTestCase ? (
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
            ) : null}
          </div>
        ) : null}

        {overviewHasExportOrRun ? (
          <div className="flex items-center gap-2">
            {onOpenExportSuite ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={onOpenExportSuite}
              >
                <Code2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Setup SDK
              </Button>
            ) : null}

            {!hideRunActions && !readOnlyConfig && hasServersConfigured ? (
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

            {!hideRunActions && (replayableLatestRun || !readOnlyConfig) ? (
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
                                ? {
                                    matchOptionsOverride:
                                      runMatchOptionsOverride,
                                  }
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
                            Boolean(evalRunsDisabledReason) ||
                            missingReplayProviderKeys.length > 0
                          : !canTriggerLiveRun ||
                            isRerunning ||
                            Boolean(evalRunsDisabledReason)
                      }
                    >
                      <RotateCw
                        className={`h-3.5 w-3.5 shrink-0 ${
                          (
                            replayableLatestRun
                              ? isReplayingLatestRun
                              : isRerunning
                          )
                            ? "animate-spin"
                            : ""
                        }`}
                        aria-hidden
                      />
                      {(
                        replayableLatestRun ? isReplayingLatestRun : isRerunning
                      )
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
                      : missingReplayProviderKeys.length > 0
                      ? `Add your ${missingReplayProviderKeys.join(
                          ", "
                        )} API key${
                          missingReplayProviderKeys.length > 1 ? "s" : ""
                        } in Settings to replay`
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
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
