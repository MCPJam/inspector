import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip } from "@/components/ui/chart";
import { BarChart, Bar, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { formatDuration } from "./helpers";
import type { DurationChartDatum, TokensChartDatum } from "./run-chart-data";
import { runDetailSectionLabelClass } from "./run-detail-typography";

export type DurationDatum = DurationChartDatum;
export type TokensDatum = TokensChartDatum;

export interface RunMetricsBarChartsProps {
  durationData: DurationDatum[];
  tokensData: TokensDatum[];
  hasTokenData: boolean;
}

// Bumped from h-16 to give the x-axis room to render test-name ticks below
// the bars. The old "Hover for test name" hint was a tax we paid because
// the chart was too short to show a name axis.
const METRICS_CHART_HEIGHT_CLASS =
  "aspect-auto h-32 w-full sm:h-36";

/**
 * Recharts XAxis tick that renders test names rotated -35° so even ~10
 * tests fit without truncation. Kept as a function component so we can
 * compose `<text>`/`<title>` for the hover tooltip; recharts will inject
 * `x`, `y`, `payload` props at render time.
 */
function RotatedTestNameTick(props: {
  x?: number;
  y?: number;
  payload?: { value?: string };
}) {
  const { x, y, payload } = props;
  if (typeof x !== "number" || typeof y !== "number" || !payload?.value) {
    return null;
  }
  const value = String(payload.value);
  const shown = value.length > 18 ? `${value.slice(0, 16)}…` : value;
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        textAnchor="end"
        transform="rotate(-35)"
        dy={4}
        dx={-2}
        fontSize={9}
        fill="hsl(var(--muted-foreground))"
      >
        {shown}
        <title>{value}</title>
      </text>
    </g>
  );
}

const durationChartConfig = {
  p50Seconds: {
    label: "p50",
    color: "color-mix(in oklch, var(--chart-1) 55%, transparent)",
  },
  p95TailSeconds: {
    label: "p95 tail",
    color: "color-mix(in oklch, var(--chart-1) 25%, transparent)",
  },
} as const;

const tokensChartConfig = {
  inputP50: {
    label: "Input p50",
    color: "color-mix(in oklch, var(--chart-2) 55%, transparent)",
  },
  outputP50: {
    label: "Output p50",
    color: "color-mix(in oklch, var(--chart-3) 55%, transparent)",
  },
  inputP95Tail: {
    label: "Input p95 tail",
    color: "color-mix(in oklch, var(--chart-2) 25%, transparent)",
  },
  outputP95Tail: {
    label: "Output p95 tail",
    color: "color-mix(in oklch, var(--chart-3) 25%, transparent)",
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
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          interval={0}
          height={48}
          tick={(tickProps) => <RotatedTestNameTick {...tickProps} />}
        />
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
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          interval={0}
          height={48}
          tick={(tickProps) => <RotatedTestNameTick {...tickProps} />}
        />
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

const metricsChartsChromeClass =
  "rounded-md border border-border/25 bg-muted/10 p-2";

function MetricsChartSectionHeader({ title }: { title: string }) {
  return (
    <div className="mb-1 flex min-w-0 items-baseline justify-between gap-2">
      <h3 className={runDetailSectionLabelClass}>{title}</h3>
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

  const durationSection = showDuration ? (
    <div className={cn("min-w-0", !singleChart && "lg:pr-3")}>
      <MetricsChartSectionHeader title="Latency by test (p50 / p95)" />
      <DurationBarBlock data={durationData} />
    </div>
  ) : null;

  const tokensSection = showTokens ? (
    <div className={cn("min-w-0", !singleChart && "lg:pl-3")}>
      <MetricsChartSectionHeader title="Tokens by test (p50 / p95)" />
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
