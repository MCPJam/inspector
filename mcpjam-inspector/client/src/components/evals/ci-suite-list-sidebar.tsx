import { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { CommitGroup, EvalSuiteOverviewEntry } from "./types";
import {
  evalOverviewEntryLeftBorderClass,
  evalOverviewEntryMiniBarClass,
  evalOverviewEntryOutcomeTitle,
  evalOverviewEntrySelectedRowClass,
} from "./helpers";
import { CommitListSidebar } from "./commit-list-sidebar";
import {
  EvalSidebarNestedRow,
  EvalSidebarParentRow,
} from "./eval-sidebar-rows";

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
  isLoading?: boolean;
  sidebarMode: SidebarMode;
  onSidebarModeChange: (mode: SidebarMode) => void;
  commitGroups: CommitGroup[];
  selectedCommitSha: string | null;
  onSelectCommit: (commitSha: string) => void;
  selectedSuiteIdInCommit?: string | null;
  onSelectSuiteInCommit?: (suiteId: string) => void;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "—";
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

function formatLastRunRelativeTime(entry: EvalSuiteOverviewEntry): string {
  const r = entry.latestRun;
  if (!r) return "—";
  return formatRelativeTime(r.completedAt ?? r.createdAt);
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
  selectedSuiteIdInCommit = null,
  onSelectSuiteInCommit,
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
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Group By</span>
          <select
            value={sidebarMode}
            onChange={(e) => onSidebarModeChange(e.target.value as SidebarMode)}
            className="text-xs border rounded px-2 py-1 bg-background"
            aria-label="Group sidebar list by"
          >
            <option value="runs">Commit</option>
            <option value="suites">Suite</option>
          </select>
        </div>
      </div>

      {sidebarMode === "runs" ? (
        <CommitListSidebar
          commitGroups={commitGroups}
          selectedCommitSha={selectedCommitSha}
          onSelectCommit={onSelectCommit}
          isLoading={isLoading}
          selectedSuiteIdInCommit={selectedSuiteIdInCommit}
          onSelectSuiteInCommit={onSelectSuiteInCommit}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              Loading suites...
            </div>
          ) : suites.length === 0 ? (
            <div className="space-y-2 p-4 text-center text-xs text-muted-foreground">
              <p>No suites found.</p>
              <p>
                Use the{" "}
                <span className="font-medium text-foreground">@mcpjam/sdk</span>{" "}
                quickstart in the main panel to create your first suite.
              </p>
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

  const lastRunTimeLabel = formatLastRunRelativeTime(primary);

  // For single-entry groups, render directly
  if (!hasMultiple) {
    return (
      <EvalSidebarParentRow
        leftBorderClassName={evalOverviewEntryLeftBorderClass(primary)}
        isSelected={selectedSuiteId === primary.suite._id}
        rowTitle={evalOverviewEntryOutcomeTitle(primary)}
        title={primary.suite.name || "Untitled suite"}
        subtitle={formatLastRunRelativeTime(primary)}
        onClick={() => onSelectSuite(primary.suite._id)}
      />
    );
  }

  // For multi-entry groups, render as expandable group
  return (
    <div>
      <div
        className={cn(
          "group flex w-full items-center border-l-2 py-2.5 pl-[15px] pr-4 transition-colors hover:bg-accent/50",
          evalOverviewEntryLeftBorderClass(primary),
          isAnySelected && "bg-accent shadow-sm",
        )}
      >
        <div
          role="button"
          tabIndex={0}
          title={evalOverviewEntryOutcomeTitle(primary)}
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
          className="flex min-w-0 flex-1 cursor-pointer items-center text-left"
        >
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
            <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
              {lastRunTimeLabel}
            </div>
          </div>
        </div>
      </div>
      {(expanded || isAnySelected) && entries.length > 1 && (
        <div className="border-l-2 border-muted ml-6">
          {entries.map((entry) => (
            <EvalSidebarNestedRow
              key={entry.suite._id}
              miniBarClassName={evalOverviewEntryMiniBarClass(entry)}
              isSelected={selectedSuiteId === entry.suite._id}
              selectedClassName={
                selectedSuiteId === entry.suite._id
                  ? evalOverviewEntrySelectedRowClass(entry)
                  : undefined
              }
              rowTitle={evalOverviewEntryOutcomeTitle(entry)}
              onClick={() => onSelectSuite(entry.suite._id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectSuite(entry.suite._id);
                }
              }}
            >
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {formatLastRunRelativeTime(entry)}
              </div>
            </EvalSidebarNestedRow>
          ))}
        </div>
      )}
    </div>
  );
}

