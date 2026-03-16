import { useState, useMemo, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommit,
  XCircle,
  CheckCircle2,
  MinusCircle,
  Clock,
  Sparkles,
  ExternalLink,
  RotateCcw,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import type { CommitGroup, EvalSuiteRun } from "./types";
import { formatDuration } from "./helpers";
import { navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import {
  classifyAllFailures,
  type FailureTag,
} from "./ai-insights";
import { useCommitTriage } from "./use-ai-triage";

interface CommitDetailViewProps {
  commitGroup: CommitGroup;
  allCommitGroups: CommitGroup[];
  onRerunRun?: (suiteId: string, runId: string) => void;
}

// Categorize runs into failed, passed, running/pending, cancelled
function categorizeRuns(runs: EvalSuiteRun[]) {
  const failed: EvalSuiteRun[] = [];
  const passed: EvalSuiteRun[] = [];
  const notRun: EvalSuiteRun[] = [];
  const running: EvalSuiteRun[] = [];

  for (const run of runs) {
    if (run.status === "running" || run.status === "pending") {
      running.push(run);
    } else if (run.result === "failed") {
      failed.push(run);
    } else if (run.result === "passed") {
      passed.push(run);
    } else {
      notRun.push(run);
    }
  }

  return { failed, passed, notRun, running };
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

/**
 * Build sparkline data for a given suite across recent commits.
 * Returns an array of { passRate, isCurrent } for the last N commits.
 */
function getSuiteSparkline(
  suiteId: string,
  currentCommitSha: string,
  allCommitGroups: CommitGroup[],
  maxPoints = 10,
): Array<{ passRate: number; isCurrent: boolean }> {
  const points: Array<{ passRate: number; isCurrent: boolean }> = [];
  // allCommitGroups is already sorted newest-first; reverse for chronological order
  const chronological = [...allCommitGroups].reverse();
  for (const group of chronological) {
    const run = group.runs.find((r) => r.suiteId === suiteId);
    if (run && run.summary && run.summary.total > 0) {
      points.push({
        passRate: Math.round((run.summary.passed / run.summary.total) * 100),
        isCurrent: group.commitSha === currentCommitSha,
      });
    }
  }
  return points.slice(-maxPoints);
}

export function CommitDetailView({
  commitGroup,
  allCommitGroups,
}: CommitDetailViewProps) {
  const [failedOpen, setFailedOpen] = useState(true);
  const [passedOpen, setPassedOpen] = useState(false);
  const [notRunOpen, setNotRunOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [compareIdx, setCompareIdx] = useState<number>(-1);

  const { failed, passed, notRun, running } = useMemo(
    () => categorizeRuns(commitGroup.runs),
    [commitGroup.runs],
  );

  const totalDuration = getTotalDuration(commitGroup.runs);
  const models = getModelsUsed(commitGroup.runs);
  const totalCases = getTotalCases(commitGroup.runs);
  const isManual = commitGroup.commitSha === "manual";

  // Compare data
  const compareOptions = useMemo(
    () =>
      allCommitGroups.filter(
        (g) => g.commitSha !== commitGroup.commitSha && g.commitSha !== "manual",
      ),
    [allCommitGroups, commitGroup.commitSha],
  );

  const compareGroup = compareIdx >= 0 ? compareOptions[compareIdx] : null;
  const compareDiff = useMemo(() => {
    if (!compareGroup) return null;
    const baseCases = getTotalCases(compareGroup.runs);
    const currCases = totalCases;
    return {
      passedDelta: currCases.passed - baseCases.passed,
      failedDelta: currCases.failed - baseCases.failed,
      durationDelta: totalDuration - getTotalDuration(compareGroup.runs),
    };
  }, [compareGroup, totalCases, totalDuration]);

  // Derive environment info from runs
  const envInfo = useMemo(() => {
    const firstRun = commitGroup.runs[0];
    if (!firstRun) return null;
    const servers = firstRun.configSnapshot?.environment?.servers ?? [];
    return {
      models: models.join(", ") || "—",
      servers: servers.join(", ") || "—",
      provider: firstRun.ciMetadata?.provider || "—",
      framework: firstRun.framework || "—",
      source: firstRun.source || "—",
    };
  }, [commitGroup.runs, models]);

  // Runs that have any failed cases — includes suites that "passed" overall
  // (due to pass rate thresholds) but still have individual case failures
  const runsWithFailedCases = useMemo(
    () => commitGroup.runs.filter((r) => (r.summary?.failed ?? 0) > 0),
    [commitGroup.runs],
  );

  // Classify failures with regression/flaky/new tags
  const classifiedFailures = useMemo(
    () =>
      classifyAllFailures(runsWithFailedCases, commitGroup.suiteMap, allCommitGroups),
    [runsWithFailedCases, commitGroup.suiteMap, allCommitGroups],
  );

  // IDs of runs with failures — used to request backend triage
  const failedRunIds = useMemo(
    () => runsWithFailedCases.map((r) => r._id),
    [runsWithFailedCases],
  );

  // AI triage via Convex backend
  const aiTriage = useCommitTriage(failedRunIds);

  // Auto-request triage when failures exist and no result yet
  useEffect(() => {
    if (failedRunIds.length > 0 && !aiTriage.summary && !aiTriage.loading && !aiTriage.unavailable) {
      aiTriage.requestTriage();
    }
  }, [failedRunIds.length, aiTriage.summary, aiTriage.loading, aiTriage.unavailable, aiTriage.requestTriage]);

  // Triage summary — shows when any cases failed
  const triageSummary = useMemo(() => {
    if (totalCases.failed === 0) return null;
    const suiteNames = runsWithFailedCases.map(
      (r) => commitGroup.suiteMap.get(r.suiteId) || "Unknown suite",
    );
    return {
      failCount: runsWithFailedCases.length,
      failedSuiteNames: suiteNames,
      totalFailedCases: totalCases.failed,
    };
  }, [runsWithFailedCases, commitGroup.suiteMap, totalCases.failed]);

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-6 pt-6">
      <div className="mx-auto max-w-[880px] space-y-4">
        {/* === HEADER & CONTEXT === */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold">
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
              failCount={failed.length}
            />
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {commitGroup.branch && (
              <span className="flex items-center gap-1">
                <GitBranch className="h-3 w-3" />
                branch: <span className="font-mono font-medium text-foreground">{commitGroup.branch}</span>
              </span>
            )}
            {!isManual && (
              <span className="flex items-center gap-1">
                <GitCommit className="h-3 w-3" />
                commit: <span className="font-mono font-medium text-foreground">{commitGroup.shortSha}</span>
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
                duration: <span className="font-mono font-medium text-foreground">{formatDuration(totalDuration)}</span>
              </span>
            )}
            {models.length > 0 && (
              <span>
                model: <span className="font-mono font-medium text-foreground">{models[0]}{models.length > 1 ? ` +${models.length - 1}` : ""}</span>
              </span>
            )}
          </div>

          {/* Pass rate progress bar + quick stats */}
          {totalCases.total > 0 && (
            <div className="mt-4 pt-4 border-t border-border/50">
              <div className="flex items-center gap-4 mb-2">
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      Overall pass rate
                    </span>
                    <span className="text-sm font-bold tabular-nums">
                      {totalCases.total > 0
                        ? Math.round(
                            (totalCases.passed / totalCases.total) * 100,
                          )
                        : 0}
                      %
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-500",
                        commitGroup.status === "passed"
                          ? "bg-emerald-500"
                          : failed.length > 0 && passed.length === 0
                            ? "bg-destructive"
                            : "bg-amber-500",
                      )}
                      style={{
                        width: `${totalCases.total > 0 ? (totalCases.passed / totalCases.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-4 text-xs tabular-nums">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium">{totalCases.passed}</span>
                  <span className="text-muted-foreground">passed</span>
                </span>
                {totalCases.failed > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-destructive" />
                    <span className="font-medium">{totalCases.failed}</span>
                    <span className="text-muted-foreground">failed</span>
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">
                    {commitGroup.runs.length} suite{commitGroup.runs.length !== 1 ? "s" : ""}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">
                    {totalCases.total} total case{totalCases.total !== 1 ? "s" : ""}
                  </span>
                </span>
              </div>
            </div>
          )}

          {/* Action buttons */}
          {failed.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border/50">
              <button
                onClick={() => {
                  for (const run of failed) {
                    navigateToCiEvalsRoute({
                      type: "run-detail",
                      suiteId: run.suiteId,
                      runId: run._id,
                    });
                    break;
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-md border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                View failures
              </button>
            </div>
          )}
        </div>

        {/* === AI TRIAGE PANEL === */}
        {triageSummary && !aiTriage.unavailable && (aiTriage.summary || aiTriage.loading || aiTriage.error) && (
          <div className="relative rounded-lg border border-orange-200/60 bg-orange-50/30 p-6 shadow-sm dark:border-orange-900/40 dark:bg-orange-950/10">
            <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-lg ai-shimmer-bar" />
            <div className="flex items-center gap-2.5 mb-4">
              <Badge
                variant="outline"
                className="border-orange-300/70 bg-orange-100/60 text-orange-700 text-[10px] font-bold uppercase tracking-wider dark:border-orange-800/50 dark:bg-orange-900/30 dark:text-orange-400"
              >
                <Sparkles className="mr-1 h-3 w-3" />
                AI
              </Badge>
              <span className="text-sm font-semibold">Triage Summary</span>
              {aiTriage.loading && (
                <span className="ml-auto text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  analyzing...
                </span>
              )}
            </div>

            {/* AI-generated summary */}
            <div className="rounded-md border border-border/40 bg-white/60 p-4 text-[13px] leading-relaxed dark:bg-black/20">
              {aiTriage.summary ? (
                <p>{aiTriage.summary}</p>
              ) : aiTriage.error ? (
                <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-xs">AI triage unavailable</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{aiTriage.error}</p>
                    <p className="text-xs mt-2">
                      <strong>{triageSummary.failCount} failure{triageSummary.failCount !== 1 ? "s" : ""} detected</strong>{" "}
                      across {triageSummary.failedSuiteNames.join(", ")} with{" "}
                      {triageSummary.totalFailedCases} failed case{triageSummary.totalFailedCases !== 1 ? "s" : ""}.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Analyzing {triageSummary.failCount} failure{triageSummary.failCount !== 1 ? "s" : ""}...</span>
                </div>
              )}
            </div>

          </div>
        )}

        {/* === COMPARE BAR === */}
        {compareOptions.length > 0 && (
          <div className="rounded-lg border bg-card shadow-sm">
            <div className="flex items-center gap-3 px-6 py-3 text-xs">
              <span className="font-medium text-muted-foreground">
                Compare with
              </span>
              <select
                className="rounded-md border bg-muted/50 px-3 py-1.5 font-mono text-xs text-foreground"
                value={compareIdx}
                onChange={(e) => setCompareIdx(Number(e.target.value))}
              >
                <option value={-1}>Select a commit...</option>
                {compareOptions.map((g, i) => (
                  <option key={g.commitSha} value={i}>
                    {g.shortSha} · {new Date(g.timestamp).toLocaleDateString()}
                  </option>
                ))}
              </select>
              {compareDiff && (
                <div className="ml-auto flex gap-4 text-xs font-medium">
                  <span
                    className={cn(
                      compareDiff.passedDelta > 0
                        ? "text-emerald-500"
                        : compareDiff.passedDelta < 0
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {compareDiff.passedDelta > 0 ? "+" : ""}
                    {compareDiff.passedDelta} passed
                  </span>
                  <span
                    className={cn(
                      compareDiff.failedDelta < 0
                        ? "text-emerald-500"
                        : compareDiff.failedDelta > 0
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {compareDiff.failedDelta > 0 ? "+" : ""}
                    {compareDiff.failedDelta} failed
                  </span>
                  {compareDiff.durationDelta !== 0 && (
                    <span className="text-muted-foreground">
                      {compareDiff.durationDelta > 0 ? "+" : ""}
                      {formatDuration(Math.abs(compareDiff.durationDelta))}{" "}
                      {compareDiff.durationDelta > 0 ? "slower" : "faster"}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* === FAILURE DETAILS === */}
        {classifiedFailures.length > 0 && (
          <div className="rounded-lg border bg-card shadow-sm">
            <div className="px-6 py-4 border-b">
              <div className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-destructive" />
                <span className="text-sm font-semibold">Failure Details</span>
                <span className="text-xs text-muted-foreground">
                  · {classifiedFailures.length} suite{classifiedFailures.length !== 1 ? "s" : ""} with failures
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 p-4">
              {classifiedFailures.slice(0, 4).map((cf) => {
                const passRate = cf.run.summary
                  ? Math.round(
                      (cf.run.summary.passed / Math.max(cf.run.summary.total, 1)) *
                        100,
                    )
                  : 0;
                return (
                  <button
                    key={cf.run._id}
                    onClick={() =>
                      navigateToCiEvalsRoute({
                        type: "run-detail",
                        suiteId: cf.run.suiteId,
                        runId: cf.run._id,
                      })
                    }
                    className="rounded-md border bg-card p-4 text-left transition-shadow hover:shadow-md hover:border-border"
                  >
                    <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                      {cf.tags.map((tag) => (
                        <FailureTagBadge key={tag} tag={tag} />
                      ))}
                      {cf.tags.length === 0 && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-destructive">
                          Investigate
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-semibold mb-1">
                      {cf.suiteName}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      <span className="text-destructive font-medium">{cf.run.summary?.failed ?? 0} failed</span> of{" "}
                      {cf.run.summary?.total ?? 0} cases · {passRate}% pass rate
                    </div>
                    <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-orange-600 dark:text-orange-400">
                      <ExternalLink className="h-3 w-3" />
                      View run details
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* === RUNNING SECTION === */}
        {running.length > 0 && (
          <RunSection
            icon={
              <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-700 dark:bg-amber-950/50">
                <span className="text-[10px] font-bold animate-pulse">⟳</span>
              </div>
            }
            title="Running"
            count={`${running.length} suite${running.length !== 1 ? "s" : ""}`}
            badgeClass="bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400"
            badgeCount={running.length}
            defaultOpen
          >
            {running.map((run) => (
              <RunRow
                key={run._id}
                run={run}
                suiteName={commitGroup.suiteMap.get(run.suiteId) || "Unknown"}
                variant="running"
              />
            ))}
          </RunSection>
        )}

        {/* === FAILED SECTION === */}
        {failed.length > 0 && (
          <RunSection
            icon={
              <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-red-200 bg-red-50 text-destructive dark:border-red-800 dark:bg-red-950/50">
                <span className="text-[10px] font-bold">✕</span>
              </div>
            }
            title="Failed"
            count={`${failed.length} suite${failed.length !== 1 ? "s" : ""} · ${totalCases.failed} cases`}
            badgeClass="bg-red-50 text-destructive border-red-200 dark:bg-red-950/50 dark:text-red-400"
            badgeCount={failed.length}
            open={failedOpen}
            onOpenChange={setFailedOpen}
            defaultOpen
          >
            {failed.map((run) => {
              const cf = classifiedFailures.find(
                (c) => c.run._id === run._id,
              );
              return (
                <FailedRunRow
                  key={run._id}
                  run={run}
                  suiteName={
                    commitGroup.suiteMap.get(run.suiteId) || "Unknown"
                  }
                  sparkline={getSuiteSparkline(
                    run.suiteId,
                    commitGroup.commitSha,
                    allCommitGroups,
                  )}
                  tags={cf?.tags ?? []}
                />
              );
            })}
          </RunSection>
        )}

        {/* === PASSED SECTION === */}
        {passed.length > 0 && (
          <RunSection
            icon={
              <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800 dark:bg-emerald-950/50">
                <span className="text-[10px] font-bold">✓</span>
              </div>
            }
            title="Passed"
            count={`${passed.length} suite${passed.length !== 1 ? "s" : ""} · ${totalCases.passed} cases`}
            badgeClass="bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400"
            badgeCount={passed.length}
            open={passedOpen}
            onOpenChange={setPassedOpen}
          >
            {passed.map((run) => (
              <RunRow
                key={run._id}
                run={run}
                suiteName={commitGroup.suiteMap.get(run.suiteId) || "Unknown"}
                variant="passed"
              />
            ))}
          </RunSection>
        )}

        {/* === NOT RUN SECTION === */}
        {notRun.length > 0 && (
          <RunSection
            icon={
              <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-700 dark:bg-amber-950/50">
                <span className="text-xs font-bold">–</span>
              </div>
            }
            title="Not Run"
            count={`${notRun.length} suite${notRun.length !== 1 ? "s" : ""}`}
            badgeClass="bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400"
            badgeCount={notRun.length}
            open={notRunOpen}
            onOpenChange={setNotRunOpen}
          >
            {notRun.map((run) => (
              <RunRow
                key={run._id}
                run={run}
                suiteName={commitGroup.suiteMap.get(run.suiteId) || "Unknown"}
                variant="notrun"
              />
            ))}
          </RunSection>
        )}

        {/* === ENVIRONMENT & CONFIG === */}
        {envInfo && (
          <Collapsible open={envOpen} onOpenChange={setEnvOpen}>
            <div className="rounded-lg border bg-card shadow-sm">
              <CollapsibleTrigger className="flex w-full items-center justify-between px-6 py-4 hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  Environment
                  <span className="text-xs font-normal text-muted-foreground">
                    · runtime context
                  </span>
                </div>
                {envOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-2 border-t">
                  <EnvCell label="Model" value={envInfo.models} />
                  <EnvCell label="MCP Server" value={envInfo.servers} />
                  <EnvCell label="Source" value={envInfo.source} />
                  <EnvCell label="Framework" value={envInfo.framework} />
                  <EnvCell label="CI Provider" value={envInfo.provider} />
                  <EnvCell
                    label="Suites"
                    value={`${commitGroup.suiteMap.size}`}
                  />
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        )}
      </div>
    </div>
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
      <Badge className="gap-1.5 bg-red-50 text-destructive border-red-200 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-400">
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

function RunSection({
  icon,
  title,
  count,
  badgeClass,
  badgeCount,
  children,
  defaultOpen,
  open,
  onOpenChange,
}: {
  icon: React.ReactNode;
  title: string;
  count: string;
  badgeClass: string;
  badgeCount: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rounded-lg border bg-card shadow-sm">
        <CollapsibleTrigger className="flex w-full items-center justify-between px-6 py-4 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            {title}
            <span className="text-xs font-normal text-muted-foreground">
              · {count}
            </span>
          </div>
          <Badge
            variant="outline"
            className={cn("text-[11px] font-semibold", badgeClass)}
          >
            {badgeCount}
          </Badge>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function FailedRunRow({
  run,
  suiteName,
  sparkline,
  tags = [],
}: {
  run: EvalSuiteRun;
  suiteName: string;
  sparkline: Array<{ passRate: number; isCurrent: boolean }>;
  tags?: FailureTag[];
}) {
  const duration = getRunDuration(run);
  const passRate = run.summary
    ? Math.round(
        (run.summary.passed / Math.max(run.summary.total, 1)) * 100,
      )
    : 0;

  return (
    <div className="border-t px-6 py-4">
      <div className="flex items-center gap-2.5 mb-3">
        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
        <button
          onClick={() =>
            navigateToCiEvalsRoute({
              type: "run-detail",
              suiteId: run.suiteId,
              runId: run._id,
            })
          }
          className="text-sm font-semibold hover:underline"
        >
          {suiteName}
        </button>
        {tags.length > 0 && (
          <div className="flex gap-1">
            {tags.map((tag) => (
              <FailureTagBadge key={tag} tag={tag} />
            ))}
          </div>
        )}
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {run.summary?.passed ?? 0}/{run.summary?.total ?? 0} · {passRate}%
        </span>
      </div>

      {/* Per-case summary with expected vs got hints */}
      {run.configSnapshot?.tests && (
        <div className="ml-6 space-y-0">
          {run.configSnapshot.tests.map((test, idx) => (
            <div
              key={idx}
              className="flex items-start gap-3 py-2 border-b border-dashed border-border/50 last:border-0 text-xs"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-foreground truncate">
                    {test.title}
                  </span>
                </div>
                {/* Show expected tool calls as a mini diff hint */}
                {test.expectedToolCalls && test.expectedToolCalls.length > 0 && (
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    expected:{" "}
                    <span className="text-emerald-500">
                      {test.expectedToolCalls.map((tc) => tc.toolName).join(", ")}
                    </span>
                  </div>
                )}
                {test.isNegativeTest && (
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    expected: <span className="text-emerald-500">no tool calls</span>
                    {test.scenario && (
                      <span className="ml-1 text-muted-foreground/70">
                        ({test.scenario})
                      </span>
                    )}
                  </div>
                )}
              </div>
              {duration !== null && (
                <span className="font-mono text-muted-foreground shrink-0 pt-0.5">
                  {formatDuration(duration / Math.max(run.configSnapshot.tests.length, 1))}
                </span>
              )}
              <div className="flex gap-1 shrink-0 pt-0.5">
                <button
                  onClick={() =>
                    navigateToCiEvalsRoute({
                      type: "run-detail",
                      suiteId: run.suiteId,
                      runId: run._id,
                    })
                  }
                  className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  View
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sparkline history */}
      {sparkline.length > 1 && (
        <div className="ml-6 mt-3 pt-3 border-t border-border/30">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
            Last {sparkline.length} runs
          </div>
          <div className="flex items-end gap-[3px] h-7">
            {sparkline.map((point, i) => (
              <div
                key={i}
                className={cn(
                  "w-[18px] rounded-t-sm transition-all",
                  point.passRate === 100
                    ? "bg-emerald-500/30"
                    : "bg-destructive/40",
                  point.isCurrent &&
                    "ring-2 ring-foreground ring-offset-1 ring-offset-background rounded-sm opacity-100",
                  point.isCurrent && point.passRate === 100
                    ? "bg-emerald-500"
                    : point.isCurrent
                      ? "bg-destructive"
                      : "",
                )}
                style={{
                  height: `${Math.max(3, (point.passRate / 100) * 28)}px`,
                }}
                title={`${point.passRate}% pass rate${point.isCurrent ? " (current)" : ""}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  suiteName,
  variant,
}: {
  run: EvalSuiteRun;
  suiteName: string;
  variant: "passed" | "running" | "notrun";
}) {
  const duration = getRunDuration(run);
  const passRate = run.summary
    ? Math.round(
        (run.summary.passed / Math.max(run.summary.total, 1)) * 100,
      )
    : 0;

  const icon =
    variant === "passed" ? (
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
    ) : variant === "running" ? (
      <Clock className="h-4 w-4 shrink-0 text-amber-500 animate-pulse" />
    ) : (
      <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
    );

  return (
    <button
      onClick={() =>
        navigateToCiEvalsRoute({
          type: "run-detail",
          suiteId: run.suiteId,
          runId: run._id,
        })
      }
      className="flex w-full items-center gap-3 border-t px-6 py-3.5 text-left hover:bg-muted/50 transition-colors"
    >
      {icon}
      <span className="flex-1 text-sm font-medium truncate">{suiteName}</span>
      {variant === "passed" && run.summary && (
        <span className="text-xs font-medium text-emerald-500 font-mono tabular-nums">
          {passRate}% · {run.summary.passed}/{run.summary.total}
        </span>
      )}
      {variant === "running" && (
        <span className="text-xs text-amber-500 font-medium">In progress...</span>
      )}
      {variant === "notrun" && (
        <Badge
          variant="outline"
          className="text-[10px] bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-950/50"
        >
          {run.result === "cancelled" ? "Cancelled" : "Skipped"}
        </Badge>
      )}
      {duration !== null && variant !== "running" && (
        <span className="text-xs font-mono text-muted-foreground tabular-nums">
          {formatDuration(duration)}
        </span>
      )}
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}

function EnvCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-r border-border/50 px-6 py-3 last:border-r-0 [&:nth-child(even)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">
        {label}
      </div>
      <div className="text-xs font-mono font-medium truncate">{value}</div>
    </div>
  );
}

function FailureTagBadge({ tag }: { tag: FailureTag }) {
  const config = {
    regression: {
      label: "regression",
      className:
        "bg-red-50 text-destructive border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800",
    },
    flaky: {
      label: "flaky",
      className:
        "bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800",
    },
    new: {
      label: "new",
      className:
        "bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800",
    },
  }[tag];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        config.className,
      )}
    >
      {config.label}
    </span>
  );
}
