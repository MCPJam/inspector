import { useMemo, type ReactElement } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import type { DotProps } from "recharts";
import { passRateColorClass } from "./suite-overview-presentation";
import { EVAL_LOW_PASS_RATE_TEXT_CLASS } from "./constants";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
} from "./eval-surface-chrome";

const modelChartConfig = {
  passRate: {
    label: "Pass Rate",
    color: "var(--chart-1)",
  },
};

type TrendDelta = {
  value: number | null;
  label: string;
  colorClass: string;
};

function computeTrendDelta(
  data: Array<{ passRate: number }>,
): TrendDelta {
  if (data.length === 0) {
    return { value: null, label: "—", colorClass: "text-muted-foreground" };
  }
  if (data.length < 2) {
    return { value: null, label: "First run", colorClass: "text-info" };
  }
  const delta =
    data[data.length - 1].passRate - data[data.length - 2].passRate;
  if (delta === 0) {
    return { value: 0, label: "No change", colorClass: "text-muted-foreground" };
  }
  return {
    value: delta,
    label: `${delta > 0 ? "+" : ""}${delta}% vs previous`,
    colorClass: delta > 0 ? "text-success" : EVAL_LOW_PASS_RATE_TEXT_CLASS,
  };
}

/**
 * Pick which sparkline points get a "%" label printed above them.
 *
 * The old rule was "annotate every dot when there are ≤10 runs," but that
 * spammed identical labels on flat trends ("25% 25% 25% 25% …"). We now
 * always show first + last, and add the run-wide min/max only when they
 * actually differ from those endpoints — so a perfectly flat trend shows
 * exactly two labels and a varying trend still surfaces its extremes.
 */
function sparklineAnnotatedIndices(data: Array<{ passRate: number }>): Set<number> {
  if (data.length === 0) return new Set();
  if (data.length === 1) return new Set([0]);

  const indices = new Set<number>([0, data.length - 1]);
  let minIndex = 0;
  let maxIndex = 0;
  for (let index = 1; index < data.length; index += 1) {
    if (data[index].passRate < data[minIndex].passRate) minIndex = index;
    if (data[index].passRate > data[maxIndex].passRate) maxIndex = index;
  }
  const firstValue = data[0].passRate;
  const lastValue = data[data.length - 1].passRate;
  if (data[minIndex].passRate !== firstValue && data[minIndex].passRate !== lastValue) {
    indices.add(minIndex);
  }
  if (data[maxIndex].passRate !== firstValue && data[maxIndex].passRate !== lastValue) {
    indices.add(maxIndex);
  }
  return indices;
}

function SparklinePointLabel({
  x,
  y,
  value,
  index,
  annotatedIndices,
}: {
  // Recharts' LabelList content widens these to string | number from its
  // SVG prop types; we only annotate numerics, so guard and skip otherwise.
  x?: number | string;
  y?: number | string;
  value?: number | string;
  index?: number;
  annotatedIndices: Set<number>;
}) {
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    value == null ||
    index == null ||
    !annotatedIndices.has(index)
  ) {
    return null;
  }

  return (
    <text
      x={x}
      y={y - 10}
      textAnchor="middle"
      fill="hsl(var(--muted-foreground))"
      fontSize={9}
      fontWeight={600}
    >
      {value}%
    </text>
  );
}

function createSparklineDot(
  pointCount: number,
  onRunClick?: (runId: string) => void,
) {
  return function SparklineDot(
    props: DotProps & { index?: number; payload?: { runId?: string } },
  ): ReactElement<SVGElement> {
    const { cx, cy, index, payload } = props;
    // Recharts' AreaDot type requires the function to return an SVGElement;
    // a no-op <g/> for the missing-coordinate case keeps the type honest.
    if (cx == null || cy == null) return <g />;

    const isLatest = index === pointCount - 1;
    const cursor = onRunClick ? "pointer" : undefined;

    return (
      <circle
        cx={cx}
        cy={cy}
        r={isLatest ? 4 : 3}
        fill="var(--color-passRate)"
        stroke="hsl(var(--background))"
        strokeWidth={2}
        style={{ cursor }}
        onClick={
          onRunClick && payload?.runId
            ? (event) => {
                event.stopPropagation();
                onRunClick(payload.runId!);
              }
            : undefined
        }
      />
    );
  };
}

function TrendDeltaBadge({ delta }: { delta: TrendDelta }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium tabular-nums",
        delta.colorClass,
      )}
    >
      {delta.value !== null && delta.value !== 0 ? (
        delta.value > 0 ? (
          <TrendingUp className="h-3 w-3" aria-hidden />
        ) : (
          <TrendingDown className="h-3 w-3" aria-hidden />
        )
      ) : null}
      {delta.label}
    </span>
  );
}

export interface SuiteRunsChartGridProps {
  suiteSource?: "ui" | "sdk";
  runTrendData: Array<{
    runId: string;
    runIdDisplay: string;
    passRate: number;
    passed?: number;
    total?: number;
    label: string;
  }>;
  modelStats: Array<{
    model: string;
    passRate: number;
    passed: number;
    failed: number;
    total: number;
  }>;
  runsLoading: boolean;
  onRunClick?: (runId: string) => void;
}

export function SuiteRunsChartGrid({
  suiteSource,
  runTrendData,
  modelStats,
  runsLoading,
  onRunClick,
}: SuiteRunsChartGridProps) {
  const isSdk = suiteSource === "sdk";
  const metricLabel = isSdk ? "Pass rate" : "Accuracy";
  const showModelChart = modelStats.length > 1;

  const latest = runTrendData.at(-1);
  const delta = useMemo(() => computeTrendDelta(runTrendData), [runTrendData]);
  const latestPassFailLabel = useMemo(() => {
    if (!latest || latest.total == null || latest.total <= 0) return null;
    const failed = Math.max(0, latest.total - (latest.passed ?? 0));
    return `${latest.passed ?? 0} passed · ${failed} failed`;
  }, [latest]);
  const annotatedIndices = useMemo(
    () => sparklineAnnotatedIndices(runTrendData),
    [runTrendData],
  );
  const SparklineDot = useMemo(
    () => createSparklineDot(runTrendData.length, onRunClick),
    [runTrendData.length, onRunClick],
  );

  return (
    <div className={cn("grid gap-4", showModelChart && "lg:grid-cols-2")}>
      <div className={evalSurfaceCardClass}>
        <div
          className={cn(
            evalSurfaceHeaderClass,
            "rounded-t-2xl px-4 py-2.5",
          )}
        >
          <div className="text-xs font-semibold tracking-tight text-foreground">
            {isSdk ? "Pass rate" : "Suite accuracy"}
          </div>
        </div>
        <div className="px-4 pb-4">
          {runsLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : !latest ? (
            <p className="text-xs text-muted-foreground">
              No completed runs yet.
            </p>
          ) : (
            <div className="flex items-stretch gap-5 sm:gap-8">
              <div className="flex shrink-0 flex-col justify-center">
                <span
                  className={cn(
                    "font-metric text-4xl font-bold tabular-nums tracking-tight",
                    passRateColorClass(latest.passRate),
                  )}
                >
                  {latest.passRate}%
                </span>
                <span className="mt-0.5 text-xs text-muted-foreground">
                  Latest {metricLabel.toLowerCase()}
                </span>
                <div className="mt-2">
                  <TrendDeltaBadge delta={delta} />
                </div>
                {latestPassFailLabel ? (
                  <span className="mt-1.5 text-xs tabular-nums text-muted-foreground">
                    {latestPassFailLabel}
                  </span>
                ) : null}
              </div>

              <div className="flex min-w-0 flex-1 flex-col justify-end">
                <span className="mb-1.5 text-[10px] text-muted-foreground">
                  Last {runTrendData.length}{" "}
                  {runTrendData.length === 1 ? "run" : "runs"}
                </span>
                <ChartContainer
                  config={{
                    passRate: {
                      label: metricLabel,
                      color: "var(--chart-1)",
                    },
                  }}
                  className="aspect-auto h-24 w-full"
                >
                  <AreaChart
                    data={runTrendData}
                    margin={{ top: 20, right: 6, left: 6, bottom: 2 }}
                    onClick={
                      onRunClick
                        ? (chartData: {
                            activePayload?: Array<{
                              payload?: { runId?: string };
                            }>;
                          }) => {
                            const runId =
                              chartData?.activePayload?.[0]?.payload?.runId;
                            if (runId) onRunClick(runId);
                          }
                        : undefined
                    }
                  >
                    <XAxis
                      dataKey="runIdDisplay"
                      hide
                      padding={{ left: 8, right: 8 }}
                    />
                    <YAxis
                      hide
                      domain={[
                        (min: number) => Math.max(0, min - 12),
                        (max: number) => Math.min(100, max + 12),
                      ]}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_, payload) => {
                            const point = payload?.[0]?.payload as
                              | { label?: string; runIdDisplay?: string }
                              | undefined;
                            return (
                              point?.label ??
                              point?.runIdDisplay ??
                              "Run"
                            );
                          }}
                        />
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="passRate"
                      stroke="var(--color-passRate)"
                      fill="var(--color-passRate)"
                      fillOpacity={0.12}
                      strokeWidth={2}
                      isAnimationActive={false}
                      dot={SparklineDot}
                      activeDot={
                        onRunClick
                          ? { cursor: "pointer", r: 5, strokeWidth: 2 }
                          : { r: 5, strokeWidth: 2 }
                      }
                    >
                      <LabelList
                        dataKey="passRate"
                        content={(props) => (
                          <SparklinePointLabel
                            {...props}
                            annotatedIndices={annotatedIndices}
                          />
                        )}
                      />
                    </Area>
                  </AreaChart>
                </ChartContainer>
              </div>
            </div>
          )}
        </div>
      </div>

      {showModelChart ? (
        <div className={evalSurfaceCardClass}>
          <div
            className={cn(
              evalSurfaceHeaderClass,
              "rounded-t-2xl px-4 py-2.5",
            )}
          >
            <div className="text-xs font-semibold tracking-tight text-foreground">
              Performance by model
            </div>
          </div>
          <div className="px-4 pb-4">
            <ChartContainer
              config={modelChartConfig}
              className="aspect-auto h-32 w-full"
            >
              <BarChart data={modelStats} width={undefined} height={undefined}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="hsl(var(--muted-foreground) / 0.2)"
                />
                <XAxis
                  dataKey="model"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 11 }}
                  interval={0}
                  height={40}
                  tickFormatter={(value: string) => {
                    if (value.length > 15) {
                      return `${value.substring(0, 12)}...`;
                    }
                    return value;
                  }}
                />
                <YAxis
                  domain={[0, 100]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value: number) => `${value}%`}
                />
                <ChartTooltip
                  cursor={false}
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0)
                      return null;
                    const data = payload[0].payload as {
                      model: string;
                      passRate: number;
                      passed: number;
                      failed: number;
                    };
                    return (
                      <div className="rounded-lg border bg-background p-2 shadow-sm">
                        <div className="grid gap-2">
                          <div className="flex flex-col">
                            <span className="text-xs font-semibold">
                              {data.model}
                            </span>
                            <span className="mt-0.5 text-xs text-muted-foreground">
                              {data.passed} passed · {data.failed} failed
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              className="h-2 w-2 rounded-full"
                              style={{
                                backgroundColor: "var(--color-passRate)",
                              }}
                            />
                            <span className="text-sm font-semibold">
                              {data.passRate}%
                            </span>
                          </div>
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
