import { GitBranch, GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommitGroup, EvalSuiteRun } from "./types";
import {
  evalStatusLeftBorderClasses,
  evalStatusMiniBarClasses,
  formatRelativeTime,
  orderCommitGroupRunsByOutcome,
} from "./helpers";

interface CommitListSidebarProps {
  commitGroups: CommitGroup[];
  selectedCommitSha: string | null;
  onSelectCommit: (commitSha: string) => void;
  isLoading?: boolean;
  /** When drilling into a commit from CI route query `suite`. */
  selectedSuiteIdInCommit?: string | null;
  onSelectSuiteInCommit?: (suiteId: string) => void;
}

function commitGroupLeftBorder(status: CommitGroup["status"]): string {
  if (status === "running") {
    return evalStatusLeftBorderClasses("running");
  }
  return evalStatusLeftBorderClasses(status);
}

function commitGroupOutcomeTitle(status: CommitGroup["status"]): string {
  switch (status) {
    case "passed":
      return "All runs passed";
    case "failed":
      return "Some runs failed";
    case "running":
      return "Runs in progress";
    case "mixed":
      return "Mixed results";
    default:
      return "Commit runs";
  }
}

function runOutcomeTitle(run: EvalSuiteRun): string {
  const isRunning = run.status === "running" || run.status === "pending";
  if (isRunning) return "Run in progress";
  if (run.result === "passed") return "Last run passed";
  if (run.result === "failed") return "Last run failed";
  if (run.status === "cancelled") return "Run cancelled";
  return "Run status";
}

export function CommitListSidebar({
  commitGroups,
  selectedCommitSha,
  onSelectCommit,
  isLoading = false,
  selectedSuiteIdInCommit = null,
  onSelectSuiteInCommit,
}: CommitListSidebarProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      {isLoading ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          Loading runs...
        </div>
      ) : commitGroups.length === 0 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          No runs found.
        </div>
      ) : (
        <div>
          {commitGroups.map((group) => {
            const isManual = group.commitSha.startsWith("manual-");
            const leftBorder = commitGroupLeftBorder(group.status);
            const isCommitSelected = selectedCommitSha === group.commitSha;
            const orderedRuns = orderCommitGroupRunsByOutcome(group.runs);

            return (
              <div key={group.commitSha}>
                <button
                  type="button"
                  title={commitGroupOutcomeTitle(group.status)}
                  onClick={() => onSelectCommit(group.commitSha)}
                  className={cn(
                    "w-full border-l-2 py-2.5 pl-[15px] pr-4 text-left transition-colors hover:bg-accent/50",
                    leftBorder,
                    isCommitSelected && "bg-accent shadow-sm",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      {isManual ? (
                        <span className="text-sm font-medium text-muted-foreground">
                          Manual
                        </span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <GitCommit className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate font-mono text-sm font-medium">
                            {group.shortSha}
                          </span>
                        </div>
                      )}
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {formatRelativeTime(group.timestamp)}
                      </span>
                    </div>

                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      {group.branch ? (
                        <div className="flex min-w-0 items-center gap-1">
                          <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate text-[11px] text-muted-foreground">
                            {group.branch}
                          </span>
                        </div>
                      ) : isManual ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {Array.from(group.suiteMap.values()).join(", ")}
                        </span>
                      ) : (
                        <div />
                      )}
                      <div className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
                        {group.summary.passed > 0 && (
                          <span className="font-medium text-emerald-600 dark:text-emerald-400">
                            {group.summary.passed} passed
                          </span>
                        )}
                        {group.summary.failed > 0 && (
                          <span className="font-medium text-destructive">
                            {group.summary.failed} failed
                          </span>
                        )}
                        {group.summary.running > 0 && (
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            {group.summary.running} running
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>

                {isCommitSelected && orderedRuns.length > 0 ? (
                  <div className="border-l-2 border-muted ml-3">
                    {orderedRuns.map((run) => {
                      const suiteName =
                        group.suiteMap.get(run.suiteId) || "Unknown";
                      const isRunning =
                        run.status === "running" || run.status === "pending";
                      const isSuiteSelected =
                        selectedSuiteIdInCommit === run.suiteId;

                      return (
                        <div
                          key={run._id}
                          className="flex w-full items-stretch gap-2 border-b border-border/40 last:border-b-0"
                        >
                          <div
                            className={cn(
                              "my-2 ml-2 w-0.5 shrink-0 self-stretch rounded-full",
                              evalStatusMiniBarClasses(
                                isRunning ? "running" : (run.result ?? "pending"),
                              ),
                            )}
                            aria-hidden
                          />
                          <div
                            role="button"
                            tabIndex={0}
                            title={runOutcomeTitle(run)}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectSuiteInCommit?.(run.suiteId);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                onSelectSuiteInCommit?.(run.suiteId);
                              }
                            }}
                            className={cn(
                              "min-w-0 flex-1 cursor-pointer py-2 pl-1 pr-3 text-left transition-colors hover:bg-accent/50",
                              isSuiteSelected &&
                                "bg-primary/10 font-medium text-foreground",
                            )}
                          >
                            <span className="block truncate text-xs font-medium">
                              {suiteName}
                            </span>
                            {isRunning ? (
                              <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                                in progress
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
