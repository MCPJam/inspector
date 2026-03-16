import { GitBranch, GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommitGroup } from "./types";
import { formatRelativeTime } from "./helpers";

interface CommitListSidebarProps {
  commitGroups: CommitGroup[];
  selectedCommitSha: string | null;
  onSelectCommit: (commitSha: string) => void;
  isLoading?: boolean;
}

function getCommitStatusInfo(group: CommitGroup): {
  dotClass: string;
  labelClass: string;
  label: string;
} {
  switch (group.status) {
    case "passed":
      return {
        dotClass: "bg-emerald-500",
        labelClass: "text-emerald-500",
        label: "Passed",
      };
    case "failed":
      return {
        dotClass: "bg-destructive",
        labelClass: "text-destructive",
        label: "Failed",
      };
    case "running":
      return {
        dotClass: "bg-warning animate-pulse",
        labelClass: "text-warning",
        label: "Running",
      };
    case "mixed":
      return {
        dotClass: "bg-amber-500",
        labelClass: "text-amber-500",
        label: "Mixed",
      };
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
            const status = getCommitStatusInfo(group);
            const isManual = group.commitSha === "manual";

            return (
              <button
                key={group.commitSha}
                onClick={() => onSelectCommit(group.commitSha)}
                className={cn(
                  "w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50",
                  selectedCommitSha === group.commitSha &&
                    "bg-accent shadow-sm",
                )}
              >
                <div className="flex items-start gap-2.5">
                  {/* Status dot */}
                  <div
                    className={cn(
                      "h-2 w-2 rounded-full mt-1.5 shrink-0",
                      status.dotClass,
                    )}
                  />

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    {/* Row 1: SHA + timestamp */}
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

                    {/* Row 2: branch + pass/fail summary */}
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      {group.branch ? (
                        <div className="flex items-center gap-1 min-w-0">
                          <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="text-[11px] text-muted-foreground truncate">
                            {group.branch}
                          </span>
                        </div>
                      ) : (
                        <div />
                      )}
                      <div className="flex items-center gap-1.5 shrink-0 text-[10px] tabular-nums">
                        {group.summary.passed > 0 && (
                          <span className="text-emerald-500 font-medium">
                            {group.summary.passed} passed
                          </span>
                        )}
                        {group.summary.failed > 0 && (
                          <span className="text-destructive font-medium">
                            {group.summary.failed} failed
                          </span>
                        )}
                        {group.summary.running > 0 && (
                          <span className="text-warning font-medium">
                            {group.summary.running} running
                          </span>
                        )}
                      </div>
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
