import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip } from "@/components/ui/chart";
import { BarChart, Bar, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { formatDuration } from "./helpers";
import type { DurationChartDatum, TokensChartDatum } from "./run-chart-data";
import {
  runDetailSectionLabelClass,
  runDetailSupportingClass,
} from "./run-detail-typography";

export type DurationDatum = DurationChartDatum;
export type TokensDatum = TokensChartDatum;

export interface RunMetricsBarChartsProps {
  durationData: DurationDatum[];
  tokensData: TokensDatum[];
  hasTokenData: boolean;
}

const METRICS_CHART_HEIGHT_CLASS =
  "aspect-auto h-16 w-full max-h-[4.5rem] sm:h-[4.5rem]";

const durationChartConfig = {
  p50Seconds: {
    label: "p50",
    color: "var(--chart-1)",
  },
  p95TailSeconds: {
    label: "p95 tail",
    color: "color-mix(in oklch, var(--chart-1) 45%, transparent)",
  },
} as const;

const tokensChartConfig = {
  inputP50: {
    label: "Input p50",
    color: "var(--chart-2)",
  },
  outputP50: {
    label: "Output p50",
    color: "var(--chart-3)",
  },
  inputP95Tail: {
    label: "Input p95 tail",
    color: "color-mix(in oklch, var(--chart-2) 45%, transparent)",
  },
  outputP95Tail: {
    label: "Output p95 tail",
    color: "color-mix(in oklch, var(--chart-3) 45%, transparent)",
  },
} as const;

function formatTokenAxis(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

function formatTokenCount(v: number): string {
  return Math.round(v).toLocaleString();
}

const metricsLegendProps = {
  content: (
    <ChartLegendContent className="gap-3 pt-0 pb-0 text-[9px] [&>div]:gap-1" />
  ),
  verticalAlign: "top" as const,
  height: 14,
};

function DurationBarBlock({ data }: { data: DurationDatum[] }) {
  return (
    <ChartContainer
      config={durationChartConfig}
      className={METRICS_CHART_HEIGHT_CLASS}
    >
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="hsl(var(--muted-foreground) / 0.12)"
        />
        <XAxis dataKey="name" hide />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          tick={{ fontSize: 10 }}
          width={36}
          tickFormatter={(v: number) =>
            v >= 60 ? `${Math.round(v / 60)}m` : `${v}s`
          }
        />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as DurationDatum;
            return (
              <div className="rounded-lg border bg-background p-2 shadow-sm">
                <div className="text-xs font-semibold">{row.name}</div>
                <div className="text-xs text-muted-foreground">
                  p50 {formatDuration(row.p50Ms)}
                </div>
                <div className="text-xs text-muted-foreground">
                  p95 {formatDuration(row.p95Ms)}
                </div>
              </div>
            );
          }}
        />
        <ChartLegend {...metricsLegendProps} />
        <Bar
          dataKey="p50Seconds"
          stackId="latency"
          fill="var(--color-p50Seconds)"
          radius={[0, 0, 0, 0]}
          isAnimationActive={false}
          maxBarSize={32}
        />
        <Bar
          dataKey="p95TailSeconds"
          stackId="latency"
          fill="var(--color-p95TailSeconds)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
          maxBarSize={32}
        />
      </BarChart>
    </ChartContainer>
  );
}

function TokensBarBlock({ data }: { data: TokensDatum[] }) {
  return (
    <ChartContainer
      config={tokensChartConfig}
      className={METRICS_CHART_HEIGHT_CLASS}
    >
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="hsl(var(--muted-foreground) / 0.12)"
        />
        <XAxis dataKey="name" hide />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          tick={{ fontSize: 10 }}
          width={40}
          tickFormatter={formatTokenAxis}
        />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as TokensDatum;
            const inputP95 = row.inputP50 + row.inputP95Tail;
            const outputP95 = row.outputP50 + row.outputP95Tail;
            return (
              <div className="rounded-lg border bg-background p-2 shadow-sm">
                <div className="text-xs font-semibold">{row.name}</div>
                <div className="text-xs text-muted-foreground">
                  Input p50 {formatTokenCount(row.inputP50)} · p95{" "}
                  {formatTokenCount(inputP95)}
                </div>
                <div className="text-xs text-muted-foreground">
                  Output p50 {formatTokenCount(row.outputP50)} · p95{" "}
                  {formatTokenCount(outputP95)}
                </div>
              </div>
            );
          }}
        />
        <ChartLegend {...metricsLegendProps} />
        {(
          [
            "inputP50",
            "outputP50",
            "inputP95Tail",
            "outputP95Tail",
          ] as const
        ).map((key) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="tokens"
            fill={`var(--color-${key})`}
            radius={key === "outputP95Tail" || key === "inputP95Tail" ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
            maxBarSize={32}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/** Shown once per chart block — belongs on the section title row, not as a banner above the grid. */
const CHART_HINT = "Hover for test name";

const metricsChartsChromeClass =
  "rounded-md border border-border/25 bg-muted/10 p-2";

function MetricsChartSectionHeader({
  title,
  showInteractionHint = false,
}: {
  title: string;
  showInteractionHint?: boolean;
}) {
  return (
    <div className="mb-1 flex min-w-0 items-baseline justify-between gap-2">
      <h3 className={runDetailSectionLabelClass}>{title}</h3>
      {showInteractionHint ? (
        <span className={cn(runDetailSupportingClass, "shrink-0 text-right")}>
          {CHART_HINT}
        </span>
      ) : null}
    </div>
  );
}

/** Side-by-side latency / token percentile stacks with minimal chrome. */
export function RunMetricsBarCharts({
  durationData,
  tokensData,
  hasTokenData,
}: RunMetricsBarChartsProps) {
  const showDuration = durationData.length > 0;
  const showTokens = hasTokenData && tokensData.length > 0;
  if (!showDuration && !showTokens) return null;

  const chartCount = (showDuration ? 1 : 0) + (showTokens ? 1 : 0);
  const singleChart = chartCount === 1;

  const showHintOnDuration = showDuration;
  const showHintOnTokens = showTokens && !showDuration;

  const durationSection = showDuration ? (
    <div className={cn("min-w-0", !singleChart && "lg:pr-3")}>
      <MetricsChartSectionHeader
        title="Latency by test (p50 / p95)"
        showInteractionHint={showHintOnDuration}
      />
      <DurationBarBlock data={durationData} />
    </div>
  ) : null;

  const tokensSection = showTokens ? (
    <div className={cn("min-w-0", !singleChart && "lg:pl-3")}>
      <MetricsChartSectionHeader
        title="Tokens by test (p50 / p95)"
        showInteractionHint={showHintOnTokens}
      />
      <TokensBarBlock data={tokensData} />
    </div>
  ) : null;

  const chartGrid = (
    <div
      className={cn(
        singleChart
          ? "min-w-0"
          : "grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-0 lg:divide-x lg:divide-border/30",
      )}
    >
      {durationSection}
      {tokensSection}
    </div>
  );

  return <div className={metricsChartsChromeClass}>{chartGrid}</div>;
}
