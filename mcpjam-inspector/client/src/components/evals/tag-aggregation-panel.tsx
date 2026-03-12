import { useState, useMemo, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { AccuracyChart } from "./accuracy-chart";
import type { TagGroupAggregate, EvalSuiteOverviewEntry } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPercent(value: number): number {
  const n = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function computeGroupTrend(entries: EvalSuiteOverviewEntry[]): number[] {
  if (entries.length === 0) return [];
  const maxLen = Math.max(...entries.map((e) => e.passRateTrend.length), 0);
  if (maxLen === 0) return [];
  return Array.from({ length: maxLen }, (_, i) => {
    const vals = entries
      .filter((e) => e.passRateTrend.length > i)
      .map((e) => e.passRateTrend[i]);
    return vals.length > 0
      ? vals.reduce((a, b) => a + b, 0) / vals.length
      : 0;
  }).slice(-12);
}

function getStatusDot(entry: EvalSuiteOverviewEntry): {
  label: string;
  dotClass: string;
} {
  const run = entry.latestRun;
  if (!run) return { label: "No runs", dotClass: "bg-muted-foreground/40" };
  if (run.status === "running" || run.status === "pending")
    return { label: "Running", dotClass: "bg-amber-500 animate-pulse" };
  if (run.result === "passed")
    return { label: "Passed", dotClass: "bg-emerald-500" };
  if (run.result === "failed")
    return { label: "Failed", dotClass: "bg-destructive" };
  return { label: run.status, dotClass: "bg-muted-foreground/40" };
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
          style={{ height: `${Math.max(3, (toPercent(value) / 100) * 100)}%` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart colors for multi-line comparison
// ---------------------------------------------------------------------------

const GROUP_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TagAggregationPanelProps {
  tagGroups: TagGroupAggregate[];
  allTags: string[];
  filterTag: string | null;
  onFilterTagChange: (tag: string | null) => void;
  onSelectSuite?: (suiteId: string) => void;
}

export function TagAggregationPanel({
  tagGroups,
  allTags,
  filterTag,
  onFilterTagChange,
  onSelectSuite,
}: TagAggregationPanelProps) {
  const [expandedTags, setExpandedTags] = useState<Set<string>>(
    () => (filterTag ? new Set([filterTag]) : new Set()),
  );

  // Auto-expand when filterTag changes
  useEffect(() => {
    if (filterTag) {
      setExpandedTags(new Set([filterTag]));
    }
  }, [filterTag]);

  const visibleGroups = useMemo(
    () => (filterTag ? tagGroups.filter((g) => g.tag === filterTag) : tagGroups),
    [tagGroups, filterTag],
  );

  // Pre-compute group trends
  const groupTrends = useMemo(
    () =>
      new Map(
        visibleGroups.map((g) => [g.tag, computeGroupTrend(g.entries)]),
      ),
    [visibleGroups],
  );

  // Multi-line trend chart data (for "All" mode)
  const hasTrendData = useMemo(
    () =>
      visibleGroups.length >= 2 &&
      visibleGroups.some((g) => (groupTrends.get(g.tag)?.length ?? 0) >= 2),
    [visibleGroups, groupTrends],
  );

  const multiLineTrendData = useMemo(() => {
    if (!hasTrendData) return [];
    const maxLen = Math.max(
      ...visibleGroups.map((g) => groupTrends.get(g.tag)?.length ?? 0),
    );
    return Array.from({ length: maxLen }, (_, i) => {
      const point: Record<string, string | number> = { index: `#${i + 1}` };
      for (const g of visibleGroups) {
        const trend = groupTrends.get(g.tag) ?? [];
        if (i < trend.length) {
          point[g.tag] = toPercent(trend[i]);
        }
      }
      return point;
    });
  }, [hasTrendData, visibleGroups, groupTrends]);

  const multiLineChartConfig = useMemo(() => {
    const config: Record<string, { label: string; color: string }> = {};
    visibleGroups.forEach((g, i) => {
      config[g.tag] = {
        label: g.tag,
        color: GROUP_COLORS[i % GROUP_COLORS.length],
      };
    });
    return config;
  }, [visibleGroups]);

  // Single-tag trend data (for AccuracyChart)
  const singleTagTrendData = useMemo(() => {
    if (visibleGroups.length !== 1) return [];
    const trend = groupTrends.get(visibleGroups[0].tag) ?? [];
    return trend.map((value, i) => ({
      runIdDisplay: `#${i + 1}`,
      passRate: toPercent(value),
    }));
  }, [visibleGroups, groupTrends]);

  // Bar chart fallback data
  const passRateBarData = useMemo(
    () =>
      visibleGroups.map((g) => ({
        tag: g.tag,
        passRate: g.passRate,
        suiteCount: g.suiteCount,
        passed: g.totals.passed,
        failed: g.totals.failed,
      })),
    [visibleGroups],
  );

  if (tagGroups.length === 0) return null;

  const toggleTag = (tag: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const isMultiGroup = visibleGroups.length > 1;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">Suite Group Comparison</h2>

      {/* Tag filter chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onFilterTagChange(null)}
          className={cn(
            "text-xs px-3 py-1 rounded-full border transition-colors",
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
              "text-xs px-3 py-1 rounded-full border transition-colors",
              filterTag === tag
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted text-muted-foreground border-border hover:border-primary/50",
            )}
          >
            {tag}
          </button>
        ))}
      </div>

      {/* Section 1 — Summary Stat Cards */}
      <div
        className={cn(
          "grid gap-4",
          visibleGroups.length === 1
            ? "grid-cols-1"
            : visibleGroups.length === 2
              ? "grid-cols-2"
              : "grid-cols-2 lg:grid-cols-3",
        )}
      >
        {visibleGroups.map((group) => {
          const trend = groupTrends.get(group.tag) ?? [];
          const trendDelta =
            trend.length >= 2
              ? toPercent(trend[trend.length - 1]) - toPercent(trend[0])
              : null;

          return (
            <div
              key={group.tag}
              className="rounded-xl border bg-card text-card-foreground p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{group.tag}</span>
                <span className="text-2xl font-bold">{group.passRate}%</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  {group.suiteCount}{" "}
                  {group.suiteCount === 1 ? "suite" : "suites"} ·{" "}
                  {group.totals.passed + group.totals.failed} tests ·{" "}
                  {group.totals.runs} runs
                </div>
                {trendDelta !== null && trendDelta !== 0 && (
                  <span
                    className={cn(
                      "flex items-center gap-1 text-xs text-muted-foreground",
                    )}
                  >
                    {trendDelta > 0 ? (
                      <TrendingUp className="h-3 w-3" />
                    ) : (
                      <TrendingDown className="h-3 w-3" />
                    )}
                    {trendDelta > 0 ? "+" : ""}
                    {trendDelta}%
                  </span>
                )}
              </div>

              {(group.totals.passed + group.totals.failed) > 0 && (
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${group.passRate}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Section 2 — Trend Comparison Chart */}
      <div className="rounded-xl border bg-card text-card-foreground">
        <div className="px-4 pt-3 pb-2">
          <div className="text-xs font-medium text-muted-foreground">
            {isMultiGroup ? "Pass Rate Trend Comparison" : "Pass Rate Trend"}
          </div>
        </div>
        <div className="px-4 pb-4">
          {isMultiGroup && hasTrendData ? (
            /* Multi-line area chart for comparing group trends */
            <ChartContainer
              config={multiLineChartConfig}
              className="aspect-auto h-48 w-full"
            >
              <AreaChart
                data={multiLineTrendData}
                width={undefined}
                height={undefined}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="hsl(var(--muted-foreground) / 0.2)"
                />
                <XAxis
                  dataKey="index"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  domain={[0, 100]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value) => `${value}%`}
                />
                <ChartTooltip
                  cursor={false}
                  content={({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; value: number; color: string }>; label?: string }) => {
                    if (!active || !payload || payload.length === 0)
                      return null;
                    return (
                      <div className="rounded-lg border bg-background p-2 shadow-sm">
                        <div className="grid gap-1">
                          <span className="text-xs font-semibold">
                            Run {label}
                          </span>
                          {payload.map((p) => (
                            <div
                              key={p.dataKey}
                              className="flex items-center gap-2"
                            >
                              <div
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: p.color }}
                              />
                              <span className="text-xs">
                                {p.dataKey}: {p.value}%
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }}
                />
                {visibleGroups.map((g, i) => (
                  <Area
                    key={g.tag}
                    type="monotone"
                    dataKey={g.tag}
                    stroke={GROUP_COLORS[i % GROUP_COLORS.length]}
                    fill={GROUP_COLORS[i % GROUP_COLORS.length]}
                    fillOpacity={0.1}
                    strokeWidth={2}
                    isAnimationActive={false}
                    dot
                    connectNulls
                  />
                ))}
              </AreaChart>
            </ChartContainer>
          ) : isMultiGroup ? (
            /* Fallback: bar chart when not enough trend data */
            <ChartContainer
              config={{
                passRate: {
                  label: "Pass Rate",
                  color: "hsl(142.1 76.2% 36.3%)",
                },
              }}
              className="aspect-auto h-48 w-full"
            >
              <BarChart
                data={passRateBarData}
                width={undefined}
                height={undefined}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="hsl(var(--muted-foreground) / 0.2)"
                />
                <XAxis
                  dataKey="tag"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 11 }}
                  interval={0}
                  height={40}
                  tickFormatter={(v) =>
                    v.length > 15 ? v.substring(0, 12) + "..." : v
                  }
                />
                <YAxis
                  domain={[0, 100]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v) => `${v}%`}
                />
                <ChartTooltip
                  cursor={false}
                  content={({ active, payload }: { active?: boolean; payload?: Array<{ payload: typeof passRateBarData[number] }> }) => {
                    if (!active || !payload || payload.length === 0)
                      return null;
                    const data = payload[0].payload;
                    return (
                      <div className="rounded-lg border bg-background p-2 shadow-sm">
                        <div className="grid gap-1">
                          <span className="text-xs font-semibold">
                            {data.tag}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {data.suiteCount}{" "}
                            {data.suiteCount === 1 ? "suite" : "suites"} ·{" "}
                            {data.passed} passed · {data.failed} failed
                          </span>
                          <span className="text-sm font-semibold">
                            {data.passRate}%
                          </span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar
                  dataKey="passRate"
                  fill="var(--color-passRate)"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                  minPointSize={8}
                />
              </BarChart>
            </ChartContainer>
          ) : (
            /* Single-tag mode: AccuracyChart */
            <AccuracyChart
              data={singleTagTrendData}
              height="h-48"
              metricLabel="Pass Rate"
            />
          )}
        </div>
      </div>

      {/* Section 3 — Enriched Suite Breakdown */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Suite Breakdown
        </h3>
        {visibleGroups.map((group) => {
          const isOpen = expandedTags.has(group.tag);
          const trend = groupTrends.get(group.tag) ?? [];
          const sortedEntries = [...group.entries].sort((a, b) => {
            const aTotal = a.totals.passed + a.totals.failed;
            const bTotal = b.totals.passed + b.totals.failed;
            const aRate = aTotal > 0 ? a.totals.passed / aTotal : 0;
            const bRate = bTotal > 0 ? b.totals.passed / bTotal : 0;
            return aRate - bRate; // worst first
          });

          return (
            <Collapsible
              key={group.tag}
              open={isOpen}
              onOpenChange={() => toggleTag(group.tag)}
            >
              <div className="rounded-xl border bg-card text-card-foreground">
                <CollapsibleTrigger className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors rounded-xl">
                  <div className="flex items-center gap-3">
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-sm font-semibold">{group.tag}</span>
                    <span className="text-xs text-muted-foreground">
                      {group.suiteCount}{" "}
                      {group.suiteCount === 1 ? "suite" : "suites"}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    {trend.length >= 2 && (
                      <Sparkline
                        data={trend}
                        className="h-5 shrink-0"
                      />
                    )}
                    <span className="text-xs text-muted-foreground">
                      <span className="text-emerald-600">
                        {group.totals.passed} passed
                      </span>
                      {" · "}
                      <span className="text-destructive">
                        {group.totals.failed} failed
                      </span>
                    </span>
                    <span className="text-sm font-bold">
                      {group.passRate}%
                    </span>
                  </div>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  {/* Column headers */}
                  <div className="flex items-center gap-4 w-full px-4 py-1.5 bg-muted/30 border-t border-b text-[11px] font-medium text-muted-foreground">
                    <div className="flex-1 min-w-0">Suite Name</div>
                    <div className="w-16 text-center">Trend</div>
                    <div className="w-8 text-center">Status</div>
                    <div className="w-20 text-right">Passed / Failed</div>
                    <div className="w-14 text-right">Pass Rate</div>
                  </div>

                  <div className="divide-y">
                    {sortedEntries.map((entry) => {
                      const total =
                        entry.totals.passed + entry.totals.failed;
                      const suitePassRate =
                        total > 0
                          ? Math.round(
                              (entry.totals.passed / total) * 100,
                            )
                          : 0;
                      const status = getStatusDot(entry);
                      const suiteTrend = entry.passRateTrend.slice(-8);

                      return (
                        <button
                          key={entry.suite._id}
                          onClick={() => onSelectSuite?.(entry.suite._id)}
                          className="w-full flex items-center gap-4 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                        >
                          <span className="text-xs font-medium truncate flex-1 min-w-0">
                            {entry.suite.name}
                          </span>
                          <div className="w-16 flex justify-center">
                            {suiteTrend.length >= 2 ? (
                              <div className="flex items-end gap-px h-4">
                                {suiteTrend.map((v, i) => (
                                  <div
                                    key={i}
                                    className="w-1 rounded-sm bg-primary/70"
                                    style={{
                                      height: `${Math.max(2, (toPercent(v) / 100) * 16)}px`,
                                    }}
                                  />
                                ))}
                              </div>
                            ) : (
                              <span className="text-[10px] text-muted-foreground">
                                —
                              </span>
                            )}
                          </div>
                          <div className="w-8 flex justify-center">
                            <div
                              className={cn(
                                "h-2 w-2 rounded-full",
                                status.dotClass,
                              )}
                              title={status.label}
                            />
                          </div>
                          <div className="w-20 text-right text-xs text-muted-foreground">
                            <span className="text-emerald-600">
                              {entry.totals.passed}
                            </span>
                            {" / "}
                            <span className="text-destructive">
                              {entry.totals.failed}
                            </span>
                          </div>
                          <span className="w-14 text-right font-mono text-xs font-medium text-foreground">
                            {suitePassRate}%
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}
