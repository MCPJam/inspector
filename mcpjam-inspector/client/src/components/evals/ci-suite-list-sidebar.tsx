import { useState, useEffect, useMemo } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { CommitGroup, EvalSuite, EvalSuiteOverviewEntry } from "./types";
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

function getMissingServers(
  suite: EvalSuite,
  connectedServerNames: Set<string> | undefined,
): string[] {
  const servers = suite.environment?.servers ?? [];
  if (!connectedServerNames || servers.length === 0) return [];
  return servers.filter((name) => !connectedServerNames.has(name));
}

export type SidebarMode = "suites" | "runs";

interface CiSuiteListSidebarProps {
  suites: EvalSuiteOverviewEntry[];
  selectedSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  isLoading?: boolean;
  sidebarMode: SidebarMode;
  onSidebarModeChange: (mode: SidebarMode) => void;
  commitGroups: CommitGroup[];
  selectedCommitSha: string | null;
  onSelectCommit: (commitSha: string) => void;
  connectedServerNames?: Set<string>;
  onRerunSuite?: (suite: EvalSuite) => void;
  rerunningSuiteId?: string | null;
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
  isLoading = false,
  sidebarMode,
  onSidebarModeChange,
  commitGroups,
  selectedCommitSha,
  onSelectCommit,
  connectedServerNames,
  onRerunSuite,
  rerunningSuiteId,
}: CiSuiteListSidebarProps) {
  useTick(); // keep "Xm ago" labels ticking

  // Group suites by base name (strip trailing timestamps/parenthetical suffixes
  // that some SDK users append, e.g. "Suite Name (2026-03-12 15:20:43)")
  const groupedSuites = useMemo(() => {
    const groups = new Map<string, EvalSuiteOverviewEntry[]>();
    for (const entry of suites) {
      const rawName = entry.suite.name || "Untitled suite";
      // Strip trailing " (YYYY-MM-DD ...)" or " (timestamp)" patterns
      const baseName =
        rawName.replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, "").trim() ||
        rawName;
      if (!groups.has(baseName)) {
        groups.set(baseName, []);
      }
      groups.get(baseName)!.push(entry);
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
  }, [suites]);

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
          ) : suites.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No suites found.
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
                    connectedServerNames={connectedServerNames}
                    onRerunSuite={onRerunSuite}
                    rerunningSuiteId={rerunningSuiteId}
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
  connectedServerNames,
  onRerunSuite,
  rerunningSuiteId,
}: {
  suiteName: string;
  entries: EvalSuiteOverviewEntry[];
  selectedSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  connectedServerNames?: Set<string>;
  onRerunSuite?: (suite: EvalSuite) => void;
  rerunningSuiteId?: string | null;
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
  const primaryMissing = getMissingServers(primary.suite, connectedServerNames);
  const canRunPrimary =
    primaryMissing.length === 0 &&
    !(rerunningSuiteId === primary.suite._id) &&
    Boolean(onRerunSuite);

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
        connectedServerNames={connectedServerNames}
        onRerunSuite={onRerunSuite}
        rerunningSuiteId={rerunningSuiteId}
      />
    );
  }

  // For multi-entry groups, render as expandable group
  return (
    <div>
      <div
        className={cn(
          "group flex w-full items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-accent/50",
          isAnySelected && "bg-accent shadow-sm",
        )}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isAnySelected) {
              onSelectSuite(primary.suite._id);
            } else {
              setExpanded(!expanded);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (!isAnySelected) {
                onSelectSuite(primary.suite._id);
              } else {
                setExpanded(!expanded);
              }
            }
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
        >
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
            {primaryMissing.length > 0 ? (
              <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                Connect {primaryMissing.join(", ")} to run.
              </p>
            ) : null}
            <div className="text-[11px] text-muted-foreground">{timestamp}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-end gap-1">
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
          {onRerunSuite ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              disabled={!canRunPrimary}
              title="Run now"
              onClick={(e) => {
                e.stopPropagation();
                void onRerunSuite(primary.suite);
              }}
            >
              <Play className="h-4 w-4 fill-current" />
            </Button>
          ) : null}
        </div>
      </div>
      {(expanded || isAnySelected) && entries.length > 1 && (
        <div className="border-l-2 border-muted ml-6">
          {entries.map((entry) => {
            const entryStatus = getStatusInfo(entry);
            const entryTimestamp = formatRelativeTime(
              entry.latestRun?.completedAt ??
                entry.latestRun?.createdAt ??
                entry.suite.updatedAt,
            );
            const missing = getMissingServers(entry.suite, connectedServerNames);
            const canRunEntry =
              missing.length === 0 &&
              !(rerunningSuiteId === entry.suite._id) &&
              Boolean(onRerunSuite);

            return (
              <div
                key={entry.suite._id}
                className="flex w-full items-center gap-2 border-b border-border/40 last:border-b-0"
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectSuite(entry.suite._id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectSuite(entry.suite._id);
                    }
                  }}
                  className={cn(
                    "min-w-0 flex-1 cursor-pointer px-3 py-1.5 text-left transition-colors hover:bg-accent/50",
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
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-muted-foreground truncate">
                        {entryTimestamp}
                      </div>
                      {missing.length > 0 ? (
                        <p className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          Connect {missing.join(", ")} to run.
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        "text-[10px] font-medium shrink-0",
                        entryStatus.labelClass,
                      )}
                    >
                      {entryStatus.label}
                    </span>
                  </div>
                </div>
                {onRerunSuite ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground"
                    disabled={!canRunEntry}
                    title="Run now"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onRerunSuite(entry.suite);
                    }}
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </Button>
                ) : null}
              </div>
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
  connectedServerNames,
  onRerunSuite,
  rerunningSuiteId,
}: {
  entry: EvalSuiteOverviewEntry;
  isSelected: boolean;
  onSelect: () => void;
  status: { label: string; dotClass: string; labelClass: string };
  trend: number[];
  timestamp: string;
  connectedServerNames?: Set<string>;
  onRerunSuite?: (suite: EvalSuite) => void;
  rerunningSuiteId?: string | null;
}) {
  const missing = getMissingServers(entry.suite, connectedServerNames);
  const canRun =
    missing.length === 0 &&
    !(rerunningSuiteId === entry.suite._id) &&
    Boolean(onRerunSuite);

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-accent/50",
        isSelected && "bg-accent shadow-sm",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
      >
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
          {missing.length > 0 ? (
            <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
              Connect {missing.join(", ")} to run.
            </p>
          ) : null}
          <div className="text-[11px] text-muted-foreground">{timestamp}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-end gap-1">
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
        {onRerunSuite ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            disabled={!canRun}
            title="Run now"
            onClick={(e) => {
              e.stopPropagation();
              void onRerunSuite(entry.suite);
            }}
          >
            <Play className="h-4 w-4 fill-current" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
