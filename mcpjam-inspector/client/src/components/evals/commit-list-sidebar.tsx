import { GitCommit } from "lucide-react";
import type { CommitGroup, EvalSuiteRun } from "./types";
import {
  evalStatusLeftBorderClasses,
  evalStatusMiniBarClasses,
  formatRelativeTime,
  orderCommitGroupRunsByOutcome,
} from "./helpers";
import {
  EvalSidebarNestedRow,
  EvalSidebarParentRow,
} from "./eval-sidebar-rows";

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

function commitGroupSubtitle(group: CommitGroup): string {
  const time = formatRelativeTime(group.timestamp);
  const stats: string[] = [];
  if (group.summary.passed > 0) {
    stats.push(`${group.summary.passed} passed`);
  }
  if (group.summary.failed > 0) {
    stats.push(`${group.summary.failed} failed`);
  }
  if (group.summary.running > 0) {
    stats.push(`${group.summary.running} running`);
  }
  const statsStr = stats.join(" · ");
  const tail = group.branch
    ? group.branch
    : group.commitSha.startsWith("manual-")
      ? Array.from(group.suiteMap.values()).join(", ")
      : "";
  return [time, statsStr, tail].filter(Boolean).join(" · ");
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
                <EvalSidebarParentRow
                  leftBorderClassName={leftBorder}
                  isSelected={isCommitSelected}
                  rowTitle={commitGroupOutcomeTitle(group.status)}
                  title={
                    isManual ? (
                      "Manual"
                    ) : (
                      <span className="flex min-w-0 items-center gap-1">
                        <GitCommit className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono">
                          {group.shortSha}
                        </span>
                      </span>
                    )
                  }
                  subtitle={commitGroupSubtitle(group)}
                  onClick={() => onSelectCommit(group.commitSha)}
                />

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
                        <EvalSidebarNestedRow
                          key={run._id}
                          miniBarClassName={evalStatusMiniBarClasses(
                            isRunning ? "running" : (run.result ?? "pending"),
                          )}
                          isSelected={isSuiteSelected}
                          selectedClassName={
                            isSuiteSelected
                              ? "bg-primary/10 font-medium text-foreground"
                              : undefined
                          }
                          innerClassName="py-2"
                          rowTitle={runOutcomeTitle(run)}
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
                        >
                          <span className="block truncate text-xs font-medium">
                            {suiteName}
                          </span>
                          {isRunning ? (
                            <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                              in progress
                            </div>
                          ) : null}
                        </EvalSidebarNestedRow>
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
