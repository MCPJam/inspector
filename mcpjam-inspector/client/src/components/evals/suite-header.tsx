import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Code2,
  GitBranch,
  Loader2,
  PanelLeft,
  Plus,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";
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
  /** When the parent hides the cases sidebar (e.g. Explore run insights landing). */
  casesSidebarHidden?: boolean;
  onShowCasesSidebar?: () => void;
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  isGeneratingTestCases?: boolean;
  onCreateTestCase?: () => void;
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
    casesSidebarHidden = false,
    onShowCasesSidebar,
    onGenerateTestCases,
    canGenerateTestCases = false,
    isGeneratingTestCases = false,
    onCreateTestCase,
    runsViewMode = "runs",
  } = props;

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
  const canRerun = replayEligibility.canRunNow;
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
        if (!isMCPJamProvidedModel(m.model)) {
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
            canRerun={canRerun}
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
    <div className="flex items-center justify-between gap-4 mb-4">
      <div className="flex items-center gap-4 flex-1">
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
      <div className="flex items-center gap-2 shrink-0">
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
        {runsViewMode === "test-cases" && onGenerateTestCases ? (
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
                  ? "Choose a connected MCP server in the playground header, then generate cases."
                  : "Generate suggested cases from your server's tools."}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {runsViewMode === "test-cases" && onCreateTestCase ? (
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
                      : !canRerun || isRerunning
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
                  ? "No connected MCP servers are configured for this suite"
                  : !canRerun
                    ? `Connect the following servers: ${missingServers.join(", ")}`
                    : "Run all cases"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
