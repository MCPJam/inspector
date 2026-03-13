import { useState, useEffect } from "react";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommitGroup, EvalSuiteOverviewEntry } from "./types";
import { TagBadges } from "./tag-editor";
import { CommitListSidebar } from "./commit-list-sidebar";

/** Force a re-render every `intervalMs` so relative timestamps stay fresh. */
function useTick(intervalMs = 60_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export type SidebarMode = "suites" | "runs";

interface CiSuiteListSidebarProps {
  suites: EvalSuiteOverviewEntry[];
  selectedSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onSelectOverview: () => void;
  isOverviewSelected: boolean;
  isLoading?: boolean;
  filterTag?: string | null;
  onFilterTagChange?: (tag: string | null) => void;
  hasTags: boolean;
  sidebarMode: SidebarMode;
  onSidebarModeChange: (mode: SidebarMode) => void;
  commitGroups: CommitGroup[];
  selectedCommitSha: string | null;
  onSelectCommit: (commitSha: string) => void;
}

function getStatusInfo(entry: EvalSuiteOverviewEntry): {
  label: string;
  dotClass: string;
  labelClass: string;
} {
  const latestRun = entry.latestRun;
  if (!latestRun) {
    return {
      label: "No runs",
      dotClass: "bg-muted-foreground/40",
      labelClass: "text-muted-foreground",
    };
  }
  if (latestRun.status === "running" || latestRun.status === "pending") {
    return {
      label: "Running",
      dotClass: "bg-warning animate-pulse",
      labelClass: "text-warning",
    };
  }
  if (latestRun.result === "passed") {
    return {
      label: "Passed",
      dotClass: "bg-emerald-500",
      labelClass: "text-emerald-500",
    };
  }
  if (latestRun.result === "failed") {
    return {
      label: "Failed",
      dotClass: "bg-destructive",
      labelClass: "text-destructive",
    };
  }
  return {
    label: latestRun.status,
    dotClass: "bg-muted-foreground/40",
    labelClass: "text-muted-foreground",
  };
}

function toPercent(value: number): number {
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "No runs yet";
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function CiSuiteListSidebar({
  suites,
  selectedSuiteId,
  onSelectSuite,
  onSelectOverview,
  isOverviewSelected,
  isLoading = false,
  filterTag,
  hasTags,
  sidebarMode,
  onSidebarModeChange,
  commitGroups,
  selectedCommitSha,
  onSelectCommit,
}: CiSuiteListSidebarProps) {
  useTick(); // keep "Xm ago" labels ticking

  const filteredSuites = filterTag
    ? suites.filter((e) => e.suite.tags?.includes(filterTag))
    : suites;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {sidebarMode === "suites" ? "Eval suites" : "Runs by commit"}
          </h2>
          {sidebarMode === "suites" && filteredSuites.length > 0 && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {filteredSuites.length}
            </span>
          )}
          {sidebarMode === "runs" && commitGroups.length > 0 && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {commitGroups.length}
            </span>
          )}
        </div>
        <div className="mt-2 flex rounded-md border bg-muted/50 p-0.5">
          <button
            onClick={() => onSidebarModeChange("suites")}
            className={cn(
              "flex-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors",
              sidebarMode === "suites"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Suites
          </button>
          <button
            onClick={() => onSidebarModeChange("runs")}
            className={cn(
              "flex-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors",
              sidebarMode === "runs"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Runs
          </button>
        </div>
      </div>

      {sidebarMode === "runs" ? (
        <CommitListSidebar
          commitGroups={commitGroups}
          selectedCommitSha={selectedCommitSha}
          onSelectCommit={onSelectCommit}
          isLoading={isLoading}
        />
      ) : (
      <div className="flex-1 overflow-y-auto">
        {hasTags && (
          <button
            onClick={onSelectOverview}
            className={cn(
              "w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50 border-b",
              isOverviewSelected && "bg-accent",
            )}
          >
            <div className="flex items-center gap-2.5">
              <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Overview</div>
                <div className="text-[11px] text-muted-foreground">
                  Suite health & status
                </div>
              </div>
              {(() => {
                const failCount = suites.filter(
                  (e) => e.latestRun?.result === "failed",
                ).length;
                return failCount > 0 ? (
                  <span className="shrink-0 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                    {failCount}
                  </span>
                ) : null;
              })()}
            </div>
          </button>
        )}
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading suites...
          </div>
        ) : filteredSuites.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No SDK suites found.
          </div>
        ) : (
          <div>
            {filteredSuites.map((entry) => {
              const latestRun = entry.latestRun;
              const status = getStatusInfo(entry);
              const trend = entry.passRateTrend
                .slice(-12)
                .map((value) => toPercent(value));
              const timestamp = formatRelativeTime(
                latestRun?.completedAt ??
                  latestRun?.createdAt ??
                  entry.suite.updatedAt,
              );

              return (
                <button
                  key={entry.suite._id}
                  onClick={() => onSelectSuite(entry.suite._id)}
                  className={cn(
                    "w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50",
                    selectedSuiteId === entry.suite._id && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <div className="flex flex-col items-center gap-0.5 shrink-0 w-[3.25rem]">
                      <div
                        className={cn("h-2 w-2 rounded-full", status.dotClass)}
                      />
                      <span
                        className={cn(
                          "text-[9px] font-medium leading-none",
                          status.labelClass,
                        )}
                      >
                        {status.label}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {entry.suite.name || "Untitled suite"}
                      </div>
                      {entry.suite.tags && entry.suite.tags.length > 0 && (
                        <TagBadges tags={entry.suite.tags} className="mt-0.5" />
                      )}
                      <div className="text-[11px] text-muted-foreground">
                        {timestamp}
                      </div>
                    </div>
                    {trend.length > 0 && (
                      <div className="flex h-5 shrink-0 items-end gap-px">
                        {trend.map((value, idx) => (
                          <div
                            key={`${entry.suite._id}-t-${idx}`}
                            className="w-1 rounded-sm bg-primary/70"
                            style={{
                              height: `${Math.max(3, (value / 100) * 20)}px`,
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
