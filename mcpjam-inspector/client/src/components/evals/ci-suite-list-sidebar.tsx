import { useState, useEffect, useMemo } from "react";
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

  // Group suites by name, keeping the most recent one as the "primary" entry
  const groupedSuites = useMemo(() => {
    const groups = new Map<string, EvalSuiteOverviewEntry[]>();
    for (const entry of filteredSuites) {
      const name = entry.suite.name || "Untitled suite";
      if (!groups.has(name)) {
        groups.set(name, []);
      }
      groups.get(name)!.push(entry);
    }
    // Sort each group by latest run time (most recent first)
    for (const entries of groups.values()) {
      entries.sort((a, b) => {
        const aTime =
          a.latestRun?.completedAt ??
          a.latestRun?.createdAt ??
          a.suite.updatedAt ??
          0;
        const bTime =
          b.latestRun?.completedAt ??
          b.latestRun?.createdAt ??
          b.suite.updatedAt ??
          0;
        return bTime - aTime;
      });
    }
    return groups;
  }, [filteredSuites]);

  const uniqueSuiteCount = groupedSuites.size;

  const failCount = suites.filter(
    (e) => e.latestRun?.result === "failed",
  ).length;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3 space-y-2">
        <div className="flex rounded-md border bg-muted/50 p-0.5">
          <button
            onClick={() => onSidebarModeChange("runs")}
            className={cn(
              "flex-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors",
              sidebarMode === "runs"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            By Commit
          </button>
          <button
            onClick={() => onSidebarModeChange("suites")}
            className={cn(
              "flex-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors",
              sidebarMode === "suites"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            By Suite
          </button>
        </div>
      </div>

      {/* Dashboard button — always visible regardless of sidebar mode */}
      <div className="px-3 py-2 border-b">
        <button
          onClick={onSelectOverview}
          className={cn(
            "w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors cursor-pointer border border-transparent",
            isOverviewSelected
              ? "bg-primary/15 text-primary border-primary/30"
              : "text-muted-foreground hover:bg-accent hover:text-foreground hover:border-border",
          )}
        >
          <BarChart3 className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Dashboard</span>
          {failCount > 0 && (
            <span className="shrink-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
              {failCount}
            </span>
          )}
        </button>
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
              {Array.from(groupedSuites.entries()).map(
                ([suiteName, entries]) => (
                  <SuiteGroupItem
                    key={suiteName}
                    suiteName={suiteName}
                    entries={entries}
                    selectedSuiteId={selectedSuiteId}
                    onSelectSuite={onSelectSuite}
                  />
                ),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SuiteGroupItem({
  suiteName,
  entries,
  selectedSuiteId,
  onSelectSuite,
}: {
  suiteName: string;
  entries: EvalSuiteOverviewEntry[];
  selectedSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
}) {
  const primary = entries[0]; // most recent
  const hasMultiple = entries.length > 1;
  const isAnySelected = entries.some((e) => e.suite._id === selectedSuiteId);
  const [expanded, setExpanded] = useState(false);

  const latestRun = primary.latestRun;
  const status = getStatusInfo(primary);
  const trend = primary.passRateTrend
    .slice(-12)
    .map((value) => toPercent(value));
  const timestamp = formatRelativeTime(
    latestRun?.completedAt ?? latestRun?.createdAt ?? primary.suite.updatedAt,
  );

  // For single-entry groups, render directly
  if (!hasMultiple) {
    return (
      <SuiteEntryButton
        entry={primary}
        isSelected={selectedSuiteId === primary.suite._id}
        onSelect={() => onSelectSuite(primary.suite._id)}
        status={status}
        trend={trend}
        timestamp={timestamp}
      />
    );
  }

  // For multi-entry groups, render as expandable group
  return (
    <div>
      <button
        onClick={() => {
          if (!isAnySelected) {
            // Click selects the most recent entry
            onSelectSuite(primary.suite._id);
          } else {
            setExpanded(!expanded);
          }
        }}
        className={cn(
          "w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50",
          isAnySelected && "bg-accent shadow-sm",
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex flex-col items-center gap-0.5 shrink-0 w-[3.25rem]">
            <div className={cn("h-2 w-2 rounded-full", status.dotClass)} />
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
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "truncate text-sm font-medium",
                  isAnySelected && "font-semibold",
                )}
              >
                {suiteName}
              </span>
              <span className="shrink-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-muted px-1 text-[9px] font-medium text-muted-foreground">
                {entries.length}
              </span>
            </div>
            {primary.suite.tags && primary.suite.tags.length > 0 && (
              <TagBadges tags={primary.suite.tags} className="mt-0.5" />
            )}
            <div className="text-[11px] text-muted-foreground">{timestamp}</div>
          </div>
          {trend.length >= 3 && (
            <div className="flex h-5 shrink-0 items-end gap-px">
              {trend.map((value, idx) => (
                <div
                  key={`${primary.suite._id}-t-${idx}`}
                  className={cn(
                    "w-1 rounded-sm",
                    value >= 80
                      ? "bg-emerald-500/70"
                      : value >= 50
                        ? "bg-amber-500/70"
                        : "bg-destructive/70",
                  )}
                  style={{ height: `${Math.max(3, (value / 100) * 20)}px` }}
                />
              ))}
            </div>
          )}
        </div>
      </button>
      {(expanded || isAnySelected) && entries.length > 1 && (
        <div className="border-l-2 border-muted ml-6">
          {entries.map((entry) => {
            const entryStatus = getStatusInfo(entry);
            const entryTimestamp = formatRelativeTime(
              entry.latestRun?.completedAt ??
                entry.latestRun?.createdAt ??
                entry.suite.updatedAt,
            );
            return (
              <button
                key={entry.suite._id}
                onClick={() => onSelectSuite(entry.suite._id)}
                className={cn(
                  "w-full px-3 py-1.5 text-left transition-colors hover:bg-accent/50",
                  selectedSuiteId === entry.suite._id &&
                    "bg-primary/10 border-r-2 border-r-primary",
                )}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      "h-1.5 w-1.5 rounded-full shrink-0",
                      entryStatus.dotClass,
                    )}
                  />
                  <span className="text-[11px] text-muted-foreground truncate flex-1">
                    {entryTimestamp}
                  </span>
                  <span
                    className={cn(
                      "text-[10px] font-medium",
                      entryStatus.labelClass,
                    )}
                  >
                    {entryStatus.label}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SuiteEntryButton({
  entry,
  isSelected,
  onSelect,
  status,
  trend,
  timestamp,
}: {
  entry: EvalSuiteOverviewEntry;
  isSelected: boolean;
  onSelect: () => void;
  status: { label: string; dotClass: string; labelClass: string };
  trend: number[];
  timestamp: string;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50",
        isSelected && "bg-accent shadow-sm",
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex flex-col items-center gap-0.5 shrink-0 w-[3.25rem]">
          <div className={cn("h-2 w-2 rounded-full", status.dotClass)} />
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
          <div
            className={cn(
              "truncate text-sm font-medium",
              isSelected && "font-semibold",
            )}
          >
            {entry.suite.name || "Untitled suite"}
          </div>
          {entry.suite.tags && entry.suite.tags.length > 0 && (
            <TagBadges tags={entry.suite.tags} className="mt-0.5" />
          )}
          <div className="text-[11px] text-muted-foreground">{timestamp}</div>
        </div>
        {trend.length >= 3 && (
          <div className="flex h-5 shrink-0 items-end gap-px">
            {trend.map((value, idx) => (
              <div
                key={`${entry.suite._id}-t-${idx}`}
                className="w-1 rounded-sm bg-primary/70"
                style={{ height: `${Math.max(3, (value / 100) * 20)}px` }}
              />
            ))}
          </div>
        )}
      </div>
    </button>
  );
}
