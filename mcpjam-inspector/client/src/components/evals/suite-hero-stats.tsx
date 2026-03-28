import { useMemo } from "react";
import { RotateCw } from "lucide-react";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Area, AreaChart, PieChart, Pie, Label } from "recharts";
import { computeIterationResult } from "./pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "./types";

interface SuiteHeroStatsProps {
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  runTrendData: Array<{
    runId: string;
    runIdDisplay: string;
    passRate: number;
    label: string;
  }>;
  modelStats: Array<{
    model: string;
    passRate: number;
    passed: number;
    failed: number;
    total: number;
  }>;
  testCaseCount: number;
  isSDK: boolean;
  onRunClick?: (runId: string) => void;
  onReplayLatestRun?: (run: EvalSuiteRun) => void;
  isReplayingLatestRun?: boolean;
}

export function SuiteHeroStats({
  runs,
  allIterations,
  runTrendData,
  modelStats,
  testCaseCount,
  isSDK,
  onRunClick,
  onReplayLatestRun,
  isReplayingLatestRun = false,
}: SuiteHeroStatsProps) {
  const stats = useMemo(() => {
    if (runs.length === 0) return null;

    const activeRunIds = new Set(runs.map((r) => r._id));
    const activeIterations = allIterations.filter(
      (iter) => iter.suiteRunId && activeRunIds.has(iter.suiteRunId),
    );

    const results = activeIterations.map((iter) =>
      computeIterationResult(iter),
    );
    const passed = results.filter((r) => r === "passed").length;
    const failed = results.filter((r) => r === "failed").length;
    const total = passed + failed;

    if (total === 0) return null;

    const accuracy = Math.round((passed / total) * 100);

    // Latest run info
    const latestRun = [...runs].sort((a, b) => {
      const aTime = a.completedAt ?? a.createdAt ?? 0;
      const bTime = b.completedAt ?? b.createdAt ?? 0;
      return bTime - aTime;
    })[0];

    const latestRunTime = latestRun?.completedAt ?? latestRun?.createdAt;
    const latestRunAgo = latestRunTime ? formatTimeAgo(latestRunTime) : null;

    // Latest run pass/fail
    const latestRunIterations = allIterations.filter(
      (iter) => iter.suiteRunId === latestRun?._id,
    );
    const latestResults = latestRunIterations.map((iter) =>
      computeIterationResult(iter),
    );
    const latestPassed = latestResults.filter((r) => r === "passed").length;
    const latestTotal = latestResults.filter(
      (r) => r === "passed" || r === "failed",
    ).length;

    // Avg duration across runs
    const completedRuns = runs.filter(
      (r) => r.completedAt && r.createdAt,
    );
    const avgDuration =
      completedRuns.length > 0
        ? completedRuns.reduce(
            (sum, r) => sum + ((r.completedAt ?? 0) - (r.createdAt ?? 0)),
            0,
          ) / completedRuns.length
        : 0;

    return {
      accuracy,
      passed,
      failed,
      total,
      runCount: runs.length,
      latestRunAgo,
      latestPassed,
      latestTotal,
      avgDuration,
      donutData: [
        ...(passed > 0
          ? [
              {
                name: "passed",
                value: passed,
                fill: "hsl(142.1 76.2% 36.3%)",
              },
            ]
          : []),
        ...(failed > 0
          ? [
              {
                name: "failed",
                value: failed,
                fill: "hsl(0 84.2% 60.2%)",
              },
            ]
          : []),
      ],
    };
  }, [runs, allIterations]);

  if (!stats) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
        No completed runs yet. Run your suite to see results.
      </div>
    );
  }

  const metricLabel = isSDK ? "Pass Rate" : "Accuracy";
  const showTrend = runTrendData.length >= 3;
  const showModelComparison = modelStats.length >= 2;
  const latestReplayableRun = [...runs]
    .filter((run) => run.hasServerReplayConfig)
    .sort((a, b) => {
      const aTime = a.completedAt ?? a.createdAt ?? 0;
      const bTime = b.completedAt ?? b.createdAt ?? 0;
      return bTime - aTime;
    })[0];

  return (
    <div className="rounded-xl border bg-card text-card-foreground">
      <div className="flex items-center gap-6 p-5">
        {/* Suite pass/fail donut */}
        <div className="shrink-0">
          <ChartContainer
            config={{
              passed: {
                label: "Passed",
                color: "hsl(142.1 76.2% 36.3%)",
              },
              failed: {
                label: "Failed",
                color: "hsl(0 84.2% 60.2%)",
              },
            }}
            className="h-[88px] w-[88px]"
          >
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie
                data={stats.donutData}
                dataKey="value"
                nameKey="name"
                innerRadius={28}
                outerRadius={40}
                strokeWidth={2}
              >
                <Label
                  content={({ viewBox }) => {
                    if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                      return (
                        <text
                          x={viewBox.cx}
                          y={viewBox.cy}
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          <tspan
                            x={viewBox.cx}
                            y={viewBox.cy}
                            className="fill-foreground text-lg font-bold"
                          >
                            {stats.accuracy}%
                          </tspan>
                        </text>
                      );
                    }
                  }}
                />
              </Pie>
            </PieChart>
          </ChartContainer>
        </div>

        {/* Stats */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-2xl font-bold">{stats.accuracy}%</span>
            <span className="text-sm text-muted-foreground">{metricLabel}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{testCaseCount} tests</span>
            <span className="text-muted-foreground/40">|</span>
            <span>{stats.runCount} runs</span>
            <span className="text-muted-foreground/40">|</span>
            <span>Avg {formatDuration(stats.avgDuration)}</span>
            {stats.latestRunAgo && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <span>
                  Latest: {stats.latestRunAgo} — {stats.latestPassed}/
                  {stats.latestTotal} passed
                </span>
              </>
            )}
          </div>
          {/* Pass/fail progress bar */}
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden flex">
              <div
                className="h-full rounded-l-full transition-all"
                style={{
                  width: `${(stats.passed / stats.total) * 100}%`,
                  backgroundColor: "hsl(142.1 76.2% 36.3%)",
                }}
              />
              <div
                className="h-full rounded-r-full transition-all"
                style={{
                  width: `${(stats.failed / stats.total) * 100}%`,
                  backgroundColor: "hsl(0 84.2% 60.2%)",
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {stats.passed} passed · {stats.failed} failed
            </span>
          </div>
        </div>

        {latestReplayableRun && onReplayLatestRun && (
          <div className="shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReplayLatestRun(latestReplayableRun)}
              disabled={isReplayingLatestRun}
              className="gap-2"
            >
              <RotateCw
                className={`h-4 w-4 ${isReplayingLatestRun ? "animate-spin" : ""}`}
              />
              {isReplayingLatestRun ? "Replaying..." : "Replay latest run"}
            </Button>
          </div>
        )}

        {/* Sparkline trend (only if ≥3 runs) */}
        {showTrend && (
          <div className="shrink-0 w-[160px]">
            <div className="text-[10px] text-muted-foreground mb-1">Trend</div>
            <ChartContainer
              config={{
                passRate: { label: metricLabel, color: "var(--chart-1)" },
              }}
              className="h-[52px] w-full"
            >
              <AreaChart
                data={runTrendData}
                onClick={
                  onRunClick
                    ? (chartData: any) => {
                        if (chartData?.activePayload?.[0]?.payload?.runId) {
                          onRunClick(chartData.activePayload[0].payload.runId);
                        }
                      }
                    : undefined
                }
              >
                <Area
                  type="monotone"
                  dataKey="passRate"
                  stroke="var(--color-passRate)"
                  fill="var(--color-passRate)"
                  fillOpacity={0.1}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={
                    onRunClick ? { cursor: "pointer", r: 4 } : undefined
                  }
                />
              </AreaChart>
            </ChartContainer>
          </div>
        )}
      </div>

      {/* Model comparison row (only if ≥2 models) */}
      {showModelComparison && (
        <div className="border-t px-5 py-3">
          <div className="text-[10px] text-muted-foreground mb-2">
            Performance by Model
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {modelStats.map((model) => (
              <div key={model.model} className="flex items-center gap-2">
                <div
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor:
                      model.passRate >= 80
                        ? "hsl(142.1 76.2% 36.3%)"
                        : model.passRate >= 50
                          ? "hsl(45.4 93.4% 47.5%)"
                          : "hsl(0 84.2% 60.2%)",
                  }}
                />
                <span className="text-xs">{model.model}</span>
                <span className="text-xs font-mono font-medium">
                  {model.passRate}%
                </span>
                <span className="text-[10px] text-muted-foreground">
                  ({model.passed}/{model.total})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
