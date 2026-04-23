import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { cn, getInitials } from "@/lib/utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  evalStatusLeftBorderClasses,
  formatDuration,
  formatRunId,
  formatTime,
} from "./helpers";
import { computeIterationResult } from "./pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "./types";

export interface SuiteRunsListProps {
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  suiteSource?: "ui" | "sdk";
  onRunClick: (runId: string) => void;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  /** Optional cap; when set, list shows at most N rows with a footer count. */
  maxVisibleRuns?: number;
  runsLoading?: boolean;
}

/**
 * Compact read-only runs list rendered inside the suite dashboard. Sits next to
 * the test cases panel as one of two balanced columns — no toolbar, no
 * selection, no batch delete. Use {@link RunOverview} when the full runs table
 * with admin affordances is needed.
 */
export function SuiteRunsList({
  runs,
  allIterations,
  suiteSource,
  onRunClick,
  userMap,
  maxVisibleRuns,
  runsLoading = false,
}: SuiteRunsListProps) {
  const isSdk = suiteSource === "sdk";
  const accuracyLabel = isSdk ? "Pass" : "Acc";

  const iterationsByRun = useMemo(() => {
    const map = new Map<string, EvalIteration[]>();
    for (const iteration of allIterations) {
      if (!iteration.suiteRunId) continue;
      const list = map.get(iteration.suiteRunId) ?? [];
      list.push(iteration);
      map.set(iteration.suiteRunId, list);
    }
    return map;
  }, [allIterations]);

  const sortedRuns = useMemo(() => {
    return [...runs].sort((a, b) => {
      const aTime = a.completedAt ?? a.createdAt ?? 0;
      const bTime = b.completedAt ?? b.createdAt ?? 0;
      return bTime - aTime;
    });
  }, [runs]);

  const visibleRuns = useMemo(() => {
    if (typeof maxVisibleRuns === "number" && maxVisibleRuns > 0) {
      return sortedRuns.slice(0, maxVisibleRuns);
    }
    return sortedRuns;
  }, [sortedRuns, maxVisibleRuns]);

  const hiddenRunCount = sortedRuns.length - visibleRuns.length;

  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card text-card-foreground">
      <div className="flex shrink-0 items-center gap-3 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
        <div className="flex-1">Run</div>
        <div className="w-16 shrink-0 text-right">{accuracyLabel}</div>
        <div className="w-16 shrink-0 text-right">Dur</div>
        <div className="w-28 shrink-0 truncate text-right">Time</div>
        <span className="w-4 shrink-0" aria-hidden />
      </div>

      <div className="max-h-[520px] divide-y overflow-y-auto">
        {runsLoading && sortedRuns.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            Loading runs…
          </div>
        ) : sortedRuns.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No runs yet. Run this suite to see results here.
          </div>
        ) : (
          visibleRuns.map((run) => {
            const runIterations = iterationsByRun.get(run._id) ?? [];
            const iterationResults = runIterations.map((i) =>
              computeIterationResult(i),
            );
            const passed = iterationResults.filter((r) => r === "passed")
              .length;
            const failed = iterationResults.filter((r) => r === "failed")
              .length;
            const completedTotal = passed + failed;
            const summaryPassed = run.summary?.passed ?? 0;
            const summaryFailed = run.summary?.failed ?? 0;
            const summaryTotal = run.summary?.total ?? 0;

            const effectivePassed = completedTotal > 0 ? passed : summaryPassed;
            const effectiveFailed = completedTotal > 0 ? failed : summaryFailed;
            const effectiveTotal =
              completedTotal > 0 ? completedTotal : summaryTotal;
            const passRate =
              effectiveTotal > 0
                ? Math.round((effectivePassed / effectiveTotal) * 100)
                : null;

            const duration =
              run.completedAt && run.createdAt
                ? formatDuration(run.completedAt - run.createdAt)
                : run.createdAt && run.status === "running"
                  ? formatDuration(Date.now() - run.createdAt)
                  : "—";

            const timestamp = run.completedAt ?? run.createdAt;
            const timestampLabel = formatTime(timestamp);

            const runResult =
              run.result ||
              (run.status === "completed" && passRate !== null
                ? passRate >= (run.passCriteria?.minimumPassRate ?? 100)
                  ? "passed"
                  : "failed"
                : run.status === "cancelled"
                  ? "cancelled"
                  : run.status === "running"
                    ? "running"
                    : "pending");

            const creator = run.createdBy
              ? userMap?.get(run.createdBy)
              : undefined;

            return (
              <div
                key={run._id}
                className={cn(
                  "relative border-l-2",
                  evalStatusLeftBorderClasses(runResult),
                )}
              >
                <button
                  type="button"
                  onClick={() => onRunClick(run._id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  aria-label={`Open run ${formatRunId(run._id)}`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-xs font-medium">
                      Run {formatRunId(run._id)}
                    </span>
                    {creator ? (
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
                    ) : null}
                  </div>
                  <div className="w-16 shrink-0 text-right text-xs font-mono tabular-nums text-muted-foreground">
                    {passRate !== null ? `${passRate}%` : "—"}
                  </div>
                  <div className="w-16 shrink-0 text-right text-xs font-mono tabular-nums text-muted-foreground">
                    {duration}
                  </div>
                  <div
                    className="w-28 shrink-0 truncate text-right text-xs tabular-nums text-muted-foreground"
                    title={timestampLabel}
                  >
                    {timestampLabel}
                  </div>
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </button>
              </div>
            );
          })
        )}
      </div>

      {hiddenRunCount > 0 ? (
        <div className="shrink-0 border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
          Showing {visibleRuns.length} of {sortedRuns.length} runs
        </div>
      ) : null}
    </div>
  );
}
