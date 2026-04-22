import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  Code2,
  GitBranch,
  Loader2,
  PanelLeft,
  Play,
  Plus,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { formatRunId } from "./helpers";
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
import { RunHeaderCompactStats } from "./run-header-compact-stats";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { getSuiteReplayEligibility } from "./replay-eligibility";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { RunDetailPlaygroundActions } from "./run-detail-playground-actions";
import type { ModelDefinition } from "@/shared/types";
import {
  SuiteOverviewModelBar,
  type SuiteOverviewModelRow,
} from "./suite-overview-model-bar";

interface SuiteHeaderProps {
  suite: EvalSuite;
  viewMode: "overview" | "run-detail" | "test-detail" | "test-edit";
  selectedRunDetails: EvalSuiteRun | null;
  isEditMode: boolean;
  onRerun: (suite: EvalSuite) => void;
  onReplayRun?: (suite: EvalSuite, run: EvalSuiteRun) => void;
  onCancelRun: (runId: string) => void;
  onViewModeChange: (mode: "overview") => void;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  replayingRunId?: string | null;
  cancellingRunId: string | null;
  runsViewMode?: "runs" | "test-cases";
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
  /** Models catalog for the suite overview model bar (same source as suite settings). */
  availableModels?: ModelDefinition[];
  /** Persists suite models for all cases (same flow as suite settings → Models). */
  onSuiteModelsUpdate?: (models: SuiteOverviewModelRow[]) => Promise<void>;
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
    isGeneratingTestCases = false,
    onCreateTestCase,
    blockTestCaseRuns = false,
    runningTestCaseId = null,
    runsViewMode = "runs",
    availableModels = [],
    onSuiteModelsUpdate,
  } = props;

  const showTestCaseCtas =
    runsViewMode === "test-cases" ||
    (unifiedSuiteDashboard && viewMode === "overview");

  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(suite.name);
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
          getBillingErrorMessage(error, "Failed to update suite name"),
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
    [handleNameBlur, suite.name],
  );

  // Calculate suite server status
  const suiteServers = suite.environment?.servers || [];
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
      (p) => !hasToken(p.toLowerCase() as keyof ProviderTokens),
    );
  }, [replayableLatestRun, testCases, hasToken]);

  if (isEditMode) {
    return (
      <div className="flex items-center justify-between gap-4 mb-2 px-6 pt-6 max-w-5xl mx-auto w-full">
        <div>
          {isEditingName && !readOnlyConfig ? (
            <input
              type="text"
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              autoFocus
              className="px-4 py-2 text-xl font-bold border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring bg-background"
            />
          ) : readOnlyConfig ? (
            <h1 className="px-4 py-2 text-xl font-bold">{suite.name}</h1>
          ) : (
            <Button
              variant="ghost"
              onClick={handleNameClick}
              className="px-4 py-2 h-auto text-xl font-bold hover:bg-accent/50 -ml-4 rounded-lg"
            >
              {suite.name}
            </Button>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onViewModeChange("overview")}
        >
          <X className="h-4 w-4 mr-2" />
          Done
        </Button>
      </div>
    );
  }

  if (viewMode === "run-detail" && selectedRunDetails) {
    return (
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-lg font-semibold tracking-tight">
              Run {formatRunId(selectedRunDetails._id)}
            </h2>
            <PassCriteriaBadge
              run={selectedRunDetails}
              variant="compact"
              metricLabel={suite.source === "sdk" ? "Pass Rate" : "Accuracy"}
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
          <RunHeaderCompactStats run={selectedRunDetails} />
        </div>
        {!hideRunActions ? (
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
        ) : null}
      </div>
    );
  }

  if (viewMode === "test-detail" || viewMode === "test-edit") {
    return null;
  }

  // Overview mode
  return (
    <div className="mb-4 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-4">
        {isEditingName ? (
          <input
            type="text"
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            autoFocus
            className="px-3 py-2 text-lg font-semibold border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : readOnlyConfig ? (
          <h2 className="px-3 py-2 text-lg font-semibold">{suite.name}</h2>
        ) : (
          <Button
            variant="ghost"
            onClick={handleNameClick}
            className="px-3 py-2 h-auto text-lg font-semibold hover:bg-accent"
          >
            {suite.name}
          </Button>
        )}
        {latestRunForMetadata && (
          <CiMetadataDisplay
            ciMetadata={latestRunForMetadata.ciMetadata}
            compact={true}
          />
        )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
        {casesSidebarHidden && onShowCasesSidebar && runsViewMode === "runs" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onShowCasesSidebar}
          >
            <PanelLeft className="h-4 w-4 mr-2" />
            Cases
          </Button>
        ) : null}
        {onSetupCi && !readOnlyConfig && (
          <Button size="sm" variant="outline" onClick={onSetupCi}>
            <GitBranch className="h-4 w-4 mr-2" />
            Setup CI
          </Button>
        )}
        {hideRunActions && showTestCaseCtas
          ? (() => {
              const testCaseCount = testCases?.length ?? 0;
              const isRunAllDisabled = Boolean(
                isRerunning ||
                  replayingRunId != null ||
                  runningTestCaseId != null ||
                  testCaseCount === 0 ||
                  !hasServersConfigured,
              );
              const runAllDisabledReasonTooltip = !hasServersConfigured
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
              const runAllButton = (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={isRunAllDisabled}
                  aria-label="Run all cases in this suite"
                  aria-busy={isRerunning}
                  onClick={() => {
                    posthog.capture("run_all_cases_button_clicked", {
                      location: "suite_header",
                      platform: detectPlatform(),
                      environment: detectEnvironment(),
                      suite_id: suite._id,
                    });
                    onRerun(suite);
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
          : null}
        {showTestCaseCtas && onGenerateTestCases ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={onGenerateTestCases}
                    disabled={!canGenerateTestCases || isGeneratingTestCases}
                    aria-busy={isGeneratingTestCases}
                  >
                    {isGeneratingTestCases ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
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
            className="h-8"
            onClick={onCreateTestCase}
          >
            <Plus className="h-3.5 w-3.5" />
            New case
          </Button>
        ) : null}
        {onOpenExportSuite ? (
          <Button size="sm" variant="outline" onClick={onOpenExportSuite}>
            <Code2 className="mr-2 h-4 w-4" />
            Setup SDK
          </Button>
        ) : null}

        {/* Action buttons */}
        {!hideRunActions && (replayableLatestRun || !readOnlyConfig) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    replayableLatestRun
                      ? onReplayRun?.(suite, replayableLatestRun)
                      : onRerun(suite)
                  }
                  disabled={
                    replayableLatestRun
                      ? isReplayingLatestRun ||
                        !onReplayRun ||
                        missingReplayProviderKeys.length > 0
                      : !canTriggerLiveRun || isRerunning
                  }
                  className="gap-2"
                >
                  <RotateCw
                    className={`h-4 w-4 ${(replayableLatestRun ? isReplayingLatestRun : isRerunning) ? "animate-spin" : ""}`}
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
                ? missingReplayProviderKeys.length > 0
                  ? `Add your ${missingReplayProviderKeys.join(", ")} API key${missingReplayProviderKeys.length > 1 ? "s" : ""} in Settings to replay`
                  : "Replay the latest CI run"
                : !hasServersConfigured
                  ? "No MCP servers are configured for this suite"
                  : missingServers.length > 0
                    ? "Connect and run."
                    : "Run all cases"}
            </TooltipContent>
          </Tooltip>
        )}
        </div>
      </div>
      {testCases.length > 0 ? (
        <SuiteOverviewModelBar
          testCases={testCases}
          availableModels={availableModels}
          readOnly={readOnlyConfig}
          onUpdate={onSuiteModelsUpdate}
        />
      ) : null}
    </div>
  );
}
