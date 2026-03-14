import { useState, useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronRight,
  Search,
  Play,
  ArrowRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { TagBadges } from "./tag-editor";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPercent(value: number): number {
  const n = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "";
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

function formatShortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Tiny inline sparkline rendered as CSS bars. */
function Sparkline({
  data,
  className,
}: {
  data: number[];
  className?: string;
}) {
  if (data.length === 0) return null;
  return (
    <div className={cn("flex items-end gap-px", className)}>
      {data.map((value, idx) => (
        <div
          key={idx}
          className="w-1.5 rounded-sm bg-primary/70"
          style={{
            height: `${Math.max(3, (toPercent(value) / 100) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run timeline bucketing
// ---------------------------------------------------------------------------

interface RunBucket {
  id: string;
  label: string;
  date: string;
  timestamp: number;
  result: "passed" | "failed" | "mixed" | "running" | "pending";
  runs: EvalSuiteRun[];
}

function buildRunTimeline(
  suites: EvalSuiteOverviewEntry[],
  maxBuckets = 10,
): RunBucket[] {
  const allRuns = suites.flatMap((e) => e.recentRuns);
  if (allRuns.length === 0) return [];

  // Sort by creation time
  const sorted = [...allRuns].sort((a, b) => a.createdAt - b.createdAt);

  // Group runs that happened within 60s of each other (same batch)
  const buckets: EvalSuiteRun[][] = [];
  let currentBucket: EvalSuiteRun[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentBucket[currentBucket.length - 1];
    if (sorted[i].createdAt - prev.createdAt < 60_000) {
      currentBucket.push(sorted[i]);
    } else {
      buckets.push(currentBucket);
      currentBucket = [sorted[i]];
    }
  }
  buckets.push(currentBucket);

  // Dedupe by taking the latest N buckets
  const recentBuckets = buckets.slice(-maxBuckets);

  return recentBuckets.map((runs, idx) => {
    const hasFailure = runs.some((r) => r.result === "failed");
    const hasRunning = runs.some(
      (r) => r.status === "running" || r.status === "pending",
    );
    const allPassed = runs.every((r) => r.result === "passed");

    const result: RunBucket["result"] = hasRunning
      ? "running"
      : hasFailure
        ? "failed"
        : allPassed
          ? "passed"
          : "mixed";

    const timestamp = Math.max(...runs.map((r) => r.createdAt));
    // Use runNumber from first run if available
    const runNum = runs[0]?.runNumber;
    const label = runNum ? `#${runNum}` : `#${idx + 1}`;

    return {
      id: `bucket-${idx}`,
      label,
      date: formatShortDate(timestamp),
      timestamp,
      result,
      runs,
    };
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface OverviewPanelProps {
  suites: EvalSuiteOverviewEntry[];
  allTags: string[];
  filterTag: string | null;
  onFilterTagChange: (tag: string | null) => void;
  onSelectSuite?: (suiteId: string) => void;
  onRerunSuite?: (suiteId: string) => void;
}

export function OverviewPanel({
  suites,
  allTags,
  filterTag,
  onFilterTagChange,
  onSelectSuite,
  onRerunSuite,
}: OverviewPanelProps) {
  const [failureFeedOpen, setFailureFeedOpen] = useState(true);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [suiteSearch, setSuiteSearch] = useState("");

  // Apply tag filter
  const filteredSuites = useMemo(
    () =>
      filterTag
        ? suites.filter((e) => e.suite.tags?.includes(filterTag))
        : suites,
    [suites, filterTag],
  );

  // ---------------------------------------------------------------------------
  // Section A: Status Banner computations
  // ---------------------------------------------------------------------------
  const stats = useMemo(() => {
    const failed = filteredSuites.filter(
      (e) => e.latestRun?.result === "failed",
    );
    const passing = filteredSuites.filter(
      (e) => e.latestRun?.result === "passed",
    );
    const running = filteredSuites.filter(
      (e) =>
        e.latestRun?.status === "running" || e.latestRun?.status === "pending",
    );
    const neverRun = filteredSuites.filter((e) => !e.latestRun);

    const lastRunTime = filteredSuites.reduce((max, e) => {
      const t =
        e.latestRun?.completedAt ?? e.latestRun?.createdAt ?? 0;
      return t > max ? t : max;
    }, 0);

    return {
      failed,
      passing,
      running,
      neverRun,
      totalSuites: filteredSuites.length,
      failedCount: failed.length,
      passingCount: passing.length,
      runningCount: running.length,
      neverRunCount: neverRun.length,
      lastRunTime: lastRunTime || undefined,
    };
  }, [filteredSuites]);

  // ---------------------------------------------------------------------------
  // Section B: Run Timeline
  // ---------------------------------------------------------------------------
  const timeline = useMemo(
    () => buildRunTimeline(filteredSuites),
    [filteredSuites],
  );

  // Auto-select latest bucket
  const activeBucketId =
    selectedBucketId ?? (timeline.length > 0 ? timeline[timeline.length - 1].id : null);

  // ---------------------------------------------------------------------------
  // Section D: Suite Table — severity-sorted, filtered, searchable
  // ---------------------------------------------------------------------------
  const tableSuites = useMemo(() => {
    let list = [...filteredSuites];

    // Search filter
    if (suiteSearch) {
      const q = suiteSearch.toLowerCase();
      list = list.filter((e) => e.suite.name.toLowerCase().includes(q));
    }

    // Failures only toggle
    if (failuresOnly) {
      list = list.filter(
        (e) => e.latestRun?.result === "failed" || !e.latestRun,
      );
    }

    // Sort by severity: failed → running → passed → never-run
    list.sort((a, b) => {
      const order = (e: EvalSuiteOverviewEntry) => {
        if (e.latestRun?.result === "failed") return 0;
        if (
          e.latestRun?.status === "running" ||
          e.latestRun?.status === "pending"
        )
          return 1;
        if (e.latestRun?.result === "passed") return 2;
        return 3; // never-run
      };
      return order(a) - order(b);
    });

    return list;
  }, [filteredSuites, suiteSearch, failuresOnly]);

  // Failure feed entries
  const failureEntries = useMemo(() => {
    return filteredSuites.filter(
      (e) => e.latestRun?.result === "failed" || !e.latestRun,
    );
  }, [filteredSuites]);

  // Auto-collapse failure feed when no failures
  const hasFailures = failureEntries.length > 0;

  // ---------------------------------------------------------------------------
  // Helpers for delta computation
  // ---------------------------------------------------------------------------
  function computeDelta(entry: EvalSuiteOverviewEntry): {
    value: number | null;
    label: string;
    colorClass: string;
  } {
    const trend = entry.passRateTrend;
    if (!entry.latestRun) {
      return { value: null, label: "—", colorClass: "text-muted-foreground" };
    }
    if (trend.length < 2) {
      return { value: null, label: "NEW", colorClass: "text-blue-500" };
    }
    const delta = Math.round(
      (trend[trend.length - 1] - trend[trend.length - 2]) * 100,
    );
    if (delta === 0) {
      return { value: 0, label: "+0%", colorClass: "text-muted-foreground" };
    }
    return {
      value: delta,
      label: `${delta > 0 ? "+" : ""}${delta}%`,
      colorClass: delta > 0 ? "text-emerald-500" : "text-destructive",
    };
  }

  function getPassRate(entry: EvalSuiteOverviewEntry): string {
    if (!entry.latestRun) return "--";
    const total = entry.totals.passed + entry.totals.failed;
    if (total === 0) return "--";
    return `${Math.round((entry.totals.passed / total) * 100)}%`;
  }

  function getStatusIcon(entry: EvalSuiteOverviewEntry) {
    if (!entry.latestRun) {
      return <MinusCircle className="h-5 w-5 text-muted-foreground" />;
    }
    if (
      entry.latestRun.status === "running" ||
      entry.latestRun.status === "pending"
    ) {
      return <Loader2 className="h-5 w-5 text-amber-500 animate-spin" />;
    }
    if (entry.latestRun.result === "passed") {
      return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
    }
    if (entry.latestRun.result === "failed") {
      return <XCircle className="h-5 w-5 text-destructive" />;
    }
    return <MinusCircle className="h-5 w-5 text-muted-foreground" />;
  }

  // ---------------------------------------------------------------------------
  // Banner state
  // ---------------------------------------------------------------------------
  const bannerState = stats.failedCount > 0
    ? "failure"
    : stats.runningCount > 0
      ? "running"
      : "success";

  const bannerConfig = {
    failure: {
      bg: "bg-destructive/10 border-destructive/30",
      icon: <AlertTriangle className="h-4 w-4 text-destructive" />,
      text: `${stats.failedCount} ${stats.failedCount === 1 ? "FAILURE" : "FAILURES"}`,
    },
    running: {
      bg: "bg-amber-500/10 border-amber-500/30",
      icon: <Loader2 className="h-4 w-4 text-amber-500 animate-spin" />,
      text: `${stats.runningCount} RUNNING`,
    },
    success: {
      bg: "bg-emerald-500/10 border-emerald-500/30",
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
      text: "ALL PASSING",
    },
  }[bannerState];

  if (filteredSuites.length === 0) return null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Section A: Status Banner */}
      <div
        className={cn(
          "rounded-lg border px-3 py-2 flex items-center gap-2.5",
          bannerConfig.bg,
        )}
      >
        {bannerConfig.icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold tracking-wide">
              {bannerConfig.text}
            </span>
            <span className="text-xs text-muted-foreground">
              {stats.passingCount}/{stats.totalSuites} passing
              {stats.neverRunCount > 0 && (
                <> &middot; {stats.neverRunCount} never run</>
              )}
            </span>
          </div>
        </div>
        {stats.lastRunTime && (
          <span className="text-xs text-muted-foreground shrink-0">
            Last run {formatRelativeTime(stats.lastRunTime)}
          </span>
        )}
      </div>

      {/* Section B: Run Timeline Chips */}
      {timeline.length > 0 && (
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {timeline.map((bucket) => {
              const isActive = bucket.id === activeBucketId;
              const chipColor =
                bucket.result === "failed"
                  ? "bg-destructive"
                  : bucket.result === "running"
                    ? "bg-amber-500"
                    : bucket.result === "passed"
                      ? "bg-emerald-500"
                      : "bg-muted-foreground";

              return (
                <button
                  key={bucket.id}
                  onClick={() => setSelectedBucketId(bucket.id)}
                  className={cn(
                    "flex flex-col items-center gap-1 px-3 py-2 rounded-lg transition-all shrink-0 min-w-[60px]",
                    isActive
                      ? "bg-accent ring-2 ring-primary/30 shadow-sm"
                      : "hover:bg-accent/50",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <div
                      className={cn("h-2.5 w-2.5 rounded-full", chipColor)}
                    />
                    <span className="text-xs font-medium">{bucket.label}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {bucket.date}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Section C: Failure Feed (Needs Attention) */}
      <Collapsible open={hasFailures && failureFeedOpen} onOpenChange={setFailureFeedOpen}>
        <div className="rounded-xl border bg-card">
          <CollapsibleTrigger className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors rounded-xl">
            <div className="flex items-center gap-2">
              {failureFeedOpen && hasFailures ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-sm font-semibold">Needs Attention</span>
              {hasFailures && (
                <span className="text-xs text-muted-foreground">
                  ({failureEntries.length})
                </span>
              )}
            </div>
            {!hasFailures && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-500">
                <CheckCircle2 className="h-3.5 w-3.5" />
                All clear
              </div>
            )}
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="border-t divide-y">
              {failureEntries.map((entry) => {
                const isFailed = entry.latestRun?.result === "failed";
                const isNeverRun = !entry.latestRun;

                return (
                  <button
                    key={entry.suite._id}
                    onClick={() => onSelectSuite?.(entry.suite._id)}
                    className="w-full px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start gap-2.5">
                      {isFailed ? (
                        <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                      ) : (
                        <MinusCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {entry.suite.name}
                        </div>
                        {isFailed && entry.latestRun?.summary && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {entry.latestRun.summary.passed}/
                            {entry.latestRun.summary.total} tests passed
                            {entry.latestRun.summary.passRate !== undefined &&
                              ` (${Math.round(entry.latestRun.summary.passRate)}%)`}
                          </div>
                        )}
                        {isFailed && entry.latestRun?.ciMetadata && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {entry.latestRun.ciMetadata.branch && (
                              <span>{entry.latestRun.ciMetadata.branch}</span>
                            )}
                            {entry.latestRun.ciMetadata.commitSha && (
                              <span>
                                {" "}
                                @ {entry.latestRun.ciMetadata.commitSha.slice(0, 7)}
                              </span>
                            )}
                            {" · "}
                            {formatRelativeTime(
                              entry.latestRun.completedAt ??
                                entry.latestRun.createdAt,
                            )}
                          </div>
                        )}
                        {isFailed && !entry.latestRun?.ciMetadata && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {formatRelativeTime(
                              entry.latestRun?.completedAt ??
                                entry.latestRun?.createdAt,
                            )}
                          </div>
                        )}
                        {isNeverRun && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            Never run
                          </div>
                        )}
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    </div>
                  </button>
                );
              })}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* Section D: Suite Table */}
      <div className="rounded-xl border bg-card">
        {/* Table toolbar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b flex-wrap">
          <button
            onClick={() => setFailuresOnly(!failuresOnly)}
            className={cn(
              "text-xs px-3 py-1 rounded-full border transition-colors",
              failuresOnly
                ? "bg-destructive/10 text-destructive border-destructive/30"
                : "bg-muted text-muted-foreground border-border hover:border-primary/50",
            )}
          >
            Failures only
          </button>

          {allTags.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onFilterTagChange(null)}
                className={cn(
                  "text-xs px-2.5 py-1 rounded-full border transition-colors",
                  !filterTag
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-border hover:border-primary/50",
                )}
              >
                All
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() =>
                    onFilterTagChange(filterTag === tag ? null : tag)
                  }
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-full border transition-colors",
                    filterTag === tag
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-border hover:border-primary/50",
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          <div className="ml-auto relative w-44">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search suites..."
              value={suiteSearch}
              onChange={(e) => setSuiteSearch(e.target.value)}
              className="h-7 w-full rounded-md border bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Table header */}
        <div className="grid grid-cols-[36px_1fr_auto_72px_64px_80px_80px_40px] items-center gap-2 px-4 py-1.5 bg-muted/30 border-b text-[11px] font-medium text-muted-foreground">
          <div>St</div>
          <div>Suite</div>
          <div className="min-w-[60px]">Tags</div>
          <div className="text-right">Pass %</div>
          <div className="text-right">Delta</div>
          <div className="text-right">Last Run</div>
          <div className="text-center">Trend</div>
          <div></div>
        </div>

        {/* Table rows */}
        <div className="divide-y">
          {tableSuites.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              No suites match your filters.
            </div>
          ) : (
            tableSuites.map((entry) => {
              const isFailed = entry.latestRun?.result === "failed";
              const delta = computeDelta(entry);
              const passRate = getPassRate(entry);
              const trend = entry.passRateTrend.slice(-8);
              const lastRunTs =
                entry.latestRun?.completedAt ?? entry.latestRun?.createdAt;

              return (
                <button
                  key={entry.suite._id}
                  onClick={() => onSelectSuite?.(entry.suite._id)}
                  className={cn(
                    "w-full grid grid-cols-[36px_1fr_auto_72px_64px_80px_80px_40px] items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors",
                    isFailed && "bg-destructive/5 border-l-2 border-l-destructive",
                  )}
                >
                  {/* Status icon */}
                  <div className="flex justify-center">
                    {getStatusIcon(entry)}
                  </div>

                  {/* Suite name */}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {entry.suite.name || "Untitled suite"}
                    </div>
                  </div>

                  {/* Tags */}
                  <div className="min-w-[60px]">
                    {entry.suite.tags && entry.suite.tags.length > 0 && (
                      <TagBadges tags={entry.suite.tags} />
                    )}
                  </div>

                  {/* Pass Rate */}
                  <div
                    className={cn(
                      "text-right font-mono text-xs font-medium",
                      passRate === "--"
                        ? "text-muted-foreground"
                        : parseInt(passRate) >= 95
                          ? "text-emerald-500"
                          : parseInt(passRate) >= 75
                            ? "text-amber-500"
                            : "text-destructive",
                    )}
                  >
                    {passRate}
                  </div>

                  {/* Delta */}
                  <div
                    className={cn(
                      "text-right text-xs font-medium flex items-center justify-end gap-0.5",
                      delta.colorClass,
                    )}
                  >
                    {delta.value !== null && delta.value !== 0 && (
                      delta.value > 0 ? (
                        <TrendingUp className="h-3 w-3" />
                      ) : (
                        <TrendingDown className="h-3 w-3" />
                      )
                    )}
                    {delta.label}
                  </div>

                  {/* Last Run */}
                  <div
                    className="text-right text-xs text-muted-foreground"
                    title={lastRunTs ? new Date(lastRunTs).toLocaleString() : undefined}
                  >
                    {lastRunTs ? formatRelativeTime(lastRunTs) : "—"}
                  </div>

                  {/* Trend sparkline */}
                  <div className="flex justify-center">
                    {trend.length >= 2 ? (
                      <Sparkline data={trend} className="h-4" />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        —
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex justify-center">
                    {onRerunSuite && (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRerunSuite(entry.suite._id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            onRerunSuite(entry.suite._id);
                          }
                        }}
                        className="p-1 rounded hover:bg-muted transition-colors"
                        title="Re-run suite"
                      >
                        <Play className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
