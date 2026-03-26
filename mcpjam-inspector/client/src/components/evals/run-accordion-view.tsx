import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import { formatRunId, getIterationBorderColor } from "./helpers";
import { computeIterationResult } from "./pass-criteria";
import { CiMetadataDisplay } from "./ci-metadata-display";
import type { EvalIteration, EvalSuiteRun } from "./types";

interface RunAccordionViewProps {
  suite: { _id: string; name: string; source?: "ui" | "sdk" };
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  onRunClick: (runId: string) => void;
  onReplayRun?: (run: EvalSuiteRun) => void;
  replayingRunId?: string | null;
  onTestCaseClick?: (testCaseId: string) => void;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
}

interface RunTestCase {
  testCaseId: string;
  title: string;
  result: "passed" | "failed" | "pending" | "cancelled";
  duration: number;
  model?: string;
}

export function RunAccordionView({
  suite,
  runs,
  allIterations,
  onRunClick,
  onReplayRun,
  replayingRunId = null,
  onTestCaseClick,
  userMap,
}: RunAccordionViewProps) {
  // Sort runs by time (latest first)
  const sortedRuns = useMemo(
    () =>
      [...runs]
        .filter((r) => r.isActive !== false)
        .sort((a, b) => {
          const aTime = a.completedAt ?? a.createdAt ?? 0;
          const bTime = b.completedAt ?? b.createdAt ?? 0;
          return bTime - aTime;
        }),
    [runs],
  );

  // Start with only the latest run expanded
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => {
    if (sortedRuns.length > 0) {
      return new Set([sortedRuns[0]._id]);
    }
    return new Set();
  });

  const toggleRun = (runId: string) => {
    setExpandedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  // Pre-compute test cases for each run
  const runTestCases = useMemo(() => {
    const map = new Map<string, RunTestCase[]>();
    for (const run of sortedRuns) {
      const runIterations = allIterations.filter(
        (iter) => iter.suiteRunId === run._id,
      );
      const testCases: RunTestCase[] = runIterations.map((iter) => ({
        testCaseId: iter.testCaseId ?? "",
        title: iter.testCaseSnapshot?.title || "Untitled test",
        result: computeIterationResult(iter),
        duration:
          iter.startedAt && iter.updatedAt
            ? iter.updatedAt - iter.startedAt
            : 0,
        model: iter.testCaseSnapshot?.model,
      }));
      // Sort: failed first, then passed, then pending
      testCases.sort((a, b) => {
        const order = { failed: 0, pending: 1, cancelled: 2, passed: 3 };
        return (order[a.result] ?? 4) - (order[b.result] ?? 4);
      });
      map.set(run._id, testCases);
    }
    return map;
  }, [sortedRuns, allIterations]);

  if (sortedRuns.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        No runs yet. Run your suite to see results here.
      </div>
    );
  }

  const metricLabel = suite.source === "sdk" ? "Pass Rate" : "Accuracy";

  return (
    <div className="rounded-xl border bg-card text-card-foreground divide-y">
      {sortedRuns.map((run, index) => {
        const isExpanded = expandedRunIds.has(run._id);
        const testCases = runTestCases.get(run._id) ?? [];
        const passed = testCases.filter((t) => t.result === "passed").length;
        const failed = testCases.filter((t) => t.result === "failed").length;
        const total = passed + failed;
        const passRate = total > 0 ? Math.round((passed / total) * 100) : null;

        const runResult =
          run.result ||
          (run.status === "completed" && passRate !== null
            ? passRate >= (run.passCriteria?.minimumPassRate ?? 100)
              ? "passed"
              : "failed"
            : run.status === "cancelled"
              ? "cancelled"
              : "pending");
        const borderColor = getIterationBorderColor(runResult);

        const duration =
          run.completedAt && run.createdAt
            ? formatDuration(run.completedAt - run.createdAt)
            : run.createdAt && run.status === "running"
              ? formatDuration(Date.now() - run.createdAt)
              : null;

        const timestamp = run.completedAt ?? run.createdAt;
        const timeAgo = timestamp ? formatTimeAgo(timestamp) : null;

        const creator = run.createdBy && userMap?.get(run.createdBy);
        const isReplayingRun = replayingRunId === run._id;

        const showCiMetadata =
          !!run.ciMetadata?.branch ||
          !!run.ciMetadata?.commitSha ||
          !!run.ciMetadata?.runUrl;

        return (
          <div key={run._id} className="relative">
            {/* Colored left border */}
            <div
              className={`absolute left-0 top-0 h-full w-1 ${borderColor} ${index === 0 ? "rounded-tl-xl" : ""} ${index === sortedRuns.length - 1 && !isExpanded ? "rounded-bl-xl" : ""}`}
            />

            {/* Run header */}
            <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => toggleRun(run._id)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-sm bg-transparent p-0 text-left appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {/* Expand/collapse chevron */}
                <span className="shrink-0 text-muted-foreground">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </span>

                {/* Run info */}
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="text-xs font-medium shrink-0">
                    Run {formatRunId(run._id)}
                  </span>

                  {timeAgo && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {timeAgo}
                    </span>
                  )}

                  {duration && (
                    <span className="text-xs font-mono text-muted-foreground shrink-0">
                      {duration}
                    </span>
                  )}

                  {showCiMetadata && (
                    <span className="shrink-0">
                      <CiMetadataDisplay
                        ciMetadata={run.ciMetadata}
                        compact={true}
                        compactMode="chip"
                        interactive={false}
                      />
                    </span>
                  )}

                  {run.replayedFromRunId && (
                    <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600">
                      Replay
                    </span>
                  )}

                  <span className="flex-1" />

                  {total > 0 && (
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-mono">
                        <span className="text-green-500">{passed}</span>
                        {failed > 0 && (
                          <>
                            <span className="text-muted-foreground"> / </span>
                            <span className="text-red-500">{failed}</span>
                          </>
                        )}
                      </span>
                      {passRate !== null && (
                        <span
                          className={cn(
                            "text-xs font-medium px-1.5 py-0.5 rounded",
                            passRate === 100
                              ? "bg-green-500/15 text-green-500"
                              : passRate >= 80
                                ? "bg-yellow-500/15 text-yellow-500"
                                : "bg-red-500/15 text-red-500",
                          )}
                        >
                          {passRate}%
                        </span>
                      )}
                    </span>
                  )}

                  {run.status === "running" && (
                    <span className="text-xs text-yellow-500 font-medium shrink-0">
                      Running...
                    </span>
                  )}

                  {creator && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Avatar className="size-5 shrink-0">
                          <AvatarImage
                            src={creator.imageUrl}
                            alt={creator.name}
                          />
                          <AvatarFallback className="text-[9px]">
                            {getInitials(creator.name)}
                          </AvatarFallback>
                        </Avatar>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">{creator.name}</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </button>

              {run.hasServerReplayConfig && onReplayRun && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onReplayRun(run)}
                        disabled={isReplayingRun}
                        className="h-7 gap-1.5 px-2 text-xs"
                      >
                        <RotateCw
                          className={`h-3.5 w-3.5 ${isReplayingRun ? "animate-spin" : ""}`}
                        />
                        {isReplayingRun ? "Replaying..." : "Replay"}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Replay this CI run</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Expanded test cases */}
            {isExpanded && (
              <div className="border-t bg-muted/20">
                {testCases.length === 0 ? (
                  <div className="px-10 py-4 text-xs text-muted-foreground">
                    {run.status === "running" || run.status === "pending"
                      ? "Tests are still running..."
                      : "No test results."}
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {testCases.map((tc, tcIndex) => {
                      const resultIcon =
                        tc.result === "passed"
                          ? "text-green-500"
                          : tc.result === "failed"
                            ? "text-red-500"
                            : "text-muted-foreground";

                      return (
                        <button
                          key={`${tc.testCaseId}-${tcIndex}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (tc.testCaseId && onTestCaseClick) {
                              onTestCaseClick(tc.testCaseId);
                            } else {
                              onRunClick(run._id);
                            }
                          }}
                          className="flex w-full items-center gap-3 px-4 pl-11 py-2 text-left transition-colors hover:bg-muted/50"
                        >
                          {/* Status dot */}
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full shrink-0",
                              tc.result === "passed"
                                ? "bg-green-500"
                                : tc.result === "failed"
                                  ? "bg-red-500"
                                  : "bg-muted-foreground",
                            )}
                          />

                          {/* Test name */}
                          <span className="text-xs flex-1 min-w-0 truncate">
                            {tc.title}
                          </span>

                          {/* Model (if shown) */}
                          {tc.model && (
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {tc.model}
                            </span>
                          )}

                          {/* Duration */}
                          {tc.duration > 0 && (
                            <span className="text-xs font-mono text-muted-foreground shrink-0">
                              {formatDuration(tc.duration)}
                            </span>
                          )}

                          {/* Result label */}
                          <span
                            className={cn(
                              "text-xs font-medium shrink-0",
                              resultIcon,
                            )}
                          >
                            {tc.result === "passed"
                              ? "Passed"
                              : tc.result === "failed"
                                ? "Failed"
                                : tc.result === "cancelled"
                                  ? "Cancelled"
                                  : "Pending"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* "View full run details" link */}
                <button
                  onClick={() => onRunClick(run._id)}
                  className="w-full px-4 pl-11 py-2 text-left text-xs text-primary hover:underline border-t border-border/50"
                >
                  View full run details
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
