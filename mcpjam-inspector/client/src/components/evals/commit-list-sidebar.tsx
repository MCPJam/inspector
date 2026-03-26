import { GitBranch, GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommitGroup } from "./types";
import { evalStatusLeftBorderClasses, formatRelativeTime } from "./helpers";

interface CommitListSidebarProps {
  commitGroups: CommitGroup[];
  selectedCommitSha: string | null;
  onSelectCommit: (commitSha: string) => void;
  isLoading?: boolean;
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

export function CommitListSidebar({
  commitGroups,
  selectedCommitSha,
  onSelectCommit,
  isLoading = false,
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

            return (
              <button
                key={group.commitSha}
                type="button"
                title={commitGroupOutcomeTitle(group.status)}
                onClick={() => onSelectCommit(group.commitSha)}
                className={cn(
                  "w-full border-l-2 py-2.5 pl-[15px] pr-4 text-left transition-colors hover:bg-accent/50",
                  leftBorder,
                  selectedCommitSha === group.commitSha &&
                    "bg-accent shadow-sm",
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
                        <span className="text-sm font-mono font-medium truncate">
                          {group.shortSha}
                        </span>
                      </div>
                    )}
                    <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
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
            );
          })}
        </div>
      )}
    </div>
  );
}
