import { useState, useMemo } from "react";
import { GitBranch, GitCommit, Clock, Loader2 } from "lucide-react";
import { useQuery } from "convex/react";
import { Badge } from "@mcpjam/design-system/badge";
import type {
  CommitGroup,
  EvalSuiteRun,
  EvalIteration,
  SuiteDetailsQueryResponse,
} from "./types";
import {
  formatDuration,
  formatRunId,
  orderCommitGroupRunsByOutcome,
} from "./helpers";
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { RunHeaderCompactStats } from "./run-header-compact-stats";
import { navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import type { CiEvalsRoute } from "@/lib/ci-evals-router";
import { useRunDetailData } from "./use-suite-data";
import { RunDetailView } from "./run-detail-view";

interface CommitDetailViewProps {
  commitGroup: CommitGroup;
  allCommitGroups?: CommitGroup[];
  onRerunRun?: (suiteId: string, runId: string) => void;
  route: CiEvalsRoute;
}

function getRunDuration(run: EvalSuiteRun): number | null {
  if (run.completedAt && run.createdAt) {
    return run.completedAt - run.createdAt;
  }
  return null;
}

function getTotalDuration(runs: EvalSuiteRun[]): number {
  let total = 0;
  for (const run of runs) {
    const d = getRunDuration(run);
    if (d) total += d;
  }
  return total;
}

function getModelsUsed(runs: EvalSuiteRun[]): string[] {
  const models = new Set<string>();
  for (const run of runs) {
    for (const test of run.configSnapshot?.tests ?? []) {
      if (test.model) models.add(test.model);
    }
  }
  return Array.from(models);
}

function getTotalCases(runs: EvalSuiteRun[]): {
  total: number;
  passed: number;
  failed: number;
} {
  let total = 0,
    passed = 0,
    failed = 0;
  for (const run of runs) {
    if (run.summary) {
      total += run.summary.total;
      passed += run.summary.passed;
      failed += run.summary.failed;
    }
  }
  return { total, passed, failed };
}

export function CommitDetailView({
  commitGroup,
  route,
}: CommitDetailViewProps) {
  const selectedSuiteId =
    route.type === "commit-detail" ? (route.suite ?? null) : null;
  const selectedIterationId =
    route.type === "commit-detail" ? (route.iteration ?? null) : null;

  const [runDetailSortBy, setRunDetailSortBy] = useState<
    "model" | "test" | "result"
  >("result");

  const totalDuration = getTotalDuration(commitGroup.runs);
  const models = getModelsUsed(commitGroup.runs);
  const totalCases = getTotalCases(commitGroup.runs);
  const isManual = commitGroup.commitSha.startsWith("manual-");

  const orderedRuns = useMemo(
    () => orderCommitGroupRunsByOutcome(commitGroup.runs),
    [commitGroup.runs],
  );

  // Find the selected run
  const selectedRun = useMemo(() => {
    if (!selectedSuiteId) return null;
    return commitGroup.runs.find((r) => r.suiteId === selectedSuiteId) ?? null;
  }, [selectedSuiteId, commitGroup.runs]);

  const handleSelectIteration = (iterationId: string) => {
    if (selectedSuiteId) {
      navigateToCiEvalsRoute({
        type: "commit-detail",
        commitSha: commitGroup.commitSha,
        suite: selectedSuiteId,
        iteration: iterationId,
      });
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Compact header */}
      <div className="shrink-0 border-b bg-background px-5 py-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h1 className="text-lg font-bold">
              {isManual ? (
                "Manual Runs"
              ) : (
                <>
                  Commit{" "}
                  <span className="font-mono">{commitGroup.shortSha}</span>
                </>
              )}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {new Date(commitGroup.timestamp).toLocaleString()}
              </span>
            </h1>
          </div>
          <StatusBadge
            status={commitGroup.status}
            failCount={
              commitGroup.runs.filter((r) => r.result === "failed").length
            }
          />
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {commitGroup.branch && (
            <span className="flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              branch:{" "}
              <span className="font-mono font-medium text-foreground">
                {commitGroup.branch}
              </span>
            </span>
          )}
          {!isManual && (
            <span className="flex items-center gap-1">
              <GitCommit className="h-3 w-3" />
              commit:{" "}
              <span className="font-mono font-medium text-foreground">
                {commitGroup.shortSha}
              </span>
            </span>
          )}
          {commitGroup.runs[0]?.ciMetadata?.provider && (
            <span>
              trigger:{" "}
              <span className="font-mono font-medium text-foreground">
                {commitGroup.runs[0].ciMetadata.provider}
              </span>
            </span>
          )}
          {totalDuration > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(totalDuration)}
            </span>
          )}
          {models.length > 0 && (
            <span>
              model:{" "}
              <span className="font-mono font-medium text-foreground">
                {models[0]}
                {models.length > 1 ? ` +${models.length - 1}` : ""}
              </span>
            </span>
          )}
        </div>

        <div className="mt-3 text-xs text-muted-foreground">
          {commitGroup.runs.length} suite
          {commitGroup.runs.length !== 1 ? "s" : ""}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto">
        {selectedRun && selectedSuiteId ? (
          <CommitSuiteRunDetail
            run={selectedRun}
            suiteId={selectedSuiteId}
            suiteName={commitGroup.suiteMap.get(selectedSuiteId) || "Unknown"}
            selectedIterationId={selectedIterationId}
            onSelectIteration={handleSelectIteration}
            runDetailSortBy={runDetailSortBy}
            onSortChange={setRunDetailSortBy}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="text-sm text-muted-foreground">
              Select a suite from the sidebar to view run details
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ========== Inline Run Detail for a Suite ==========

function CommitSuiteRunDetail({
  run,
  suiteId,
  suiteName,
  selectedIterationId,
  onSelectIteration,
  runDetailSortBy,
  onSortChange,
}: {
  run: EvalSuiteRun;
  suiteId: string;
  suiteName: string;
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
}) {
  // Load iterations for this suite
  const suiteDetails = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
    { suiteId } as any,
  ) as SuiteDetailsQueryResponse | undefined;

  const allIterations: EvalIteration[] = useMemo(
    () => (suiteDetails ? [...suiteDetails.iterations] : []),
    [suiteDetails],
  );

  const { caseGroupsForSelectedRun, selectedRunChartData } = useRunDetailData(
    run._id,
    allIterations,
    runDetailSortBy,
  );

  if (!suiteDetails) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading {suiteName}...
        </div>
      </div>
    );
  }

  const metricLabel = run.source === "sdk" ? "Pass Rate" : "Accuracy";

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1 px-4 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            Run {formatRunId(run._id)}
          </h2>
          <PassCriteriaBadge
            run={run}
            variant="compact"
            metricLabel={metricLabel}
          />
        </div>
        <RunHeaderCompactStats run={run} />
      </div>
      <RunDetailView
        selectedRunDetails={run}
        caseGroupsForSelectedRun={caseGroupsForSelectedRun}
        source={run.source as "ui" | "sdk" | undefined}
        selectedRunChartData={selectedRunChartData}
        runDetailSortBy={runDetailSortBy}
        onSortChange={onSortChange}
        serverNames={run.configSnapshot?.environment?.servers ?? []}
        selectedIterationId={selectedIterationId}
        onSelectIteration={onSelectIteration}
        hideCiMetadata
      />
    </>
  );
}

// ========== Sub-components ==========

function StatusBadge({
  status,
  failCount,
}: {
  status: CommitGroup["status"];
  failCount: number;
}) {
  if (status === "passed") {
    return (
      <Badge className="gap-1.5 bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Passed
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge className="gap-1.5 bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20 dark:bg-destructive/20 dark:border-destructive/40">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        {failCount} Failed
      </Badge>
    );
  }
  if (status === "running") {
    return (
      <Badge className="gap-1.5 bg-amber-50 text-amber-600 border-amber-200 hover:bg-amber-100 dark:bg-amber-950/50 dark:text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
        Running
      </Badge>
    );
  }
  return (
    <Badge className="gap-1.5 bg-amber-50 text-amber-600 border-amber-200 hover:bg-amber-100 dark:bg-amber-950/50 dark:text-amber-400">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Mixed
    </Badge>
  );
}
