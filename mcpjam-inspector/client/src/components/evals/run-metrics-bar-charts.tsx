import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { BarChart, Bar, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { formatDuration } from "./helpers";

export type DurationDatum = {
  name: string;
  duration: number;
  durationSeconds: number;
};

export type TokensDatum = {
  name: string;
  tokens: number;
};

export interface RunMetricsBarChartsProps {
  durationData: DurationDatum[];
  tokensData: TokensDatum[];
  hasTokenData: boolean;
}

function DurationBarBlock({ data }: { data: DurationDatum[] }) {
  return (
    <ChartContainer
      config={{
        durationSeconds: {
          label: "Duration",
          color: "var(--chart-1)",
        },
      }}
      className="aspect-auto h-[min(120px,18vh)] w-full max-h-[140px]"
    >
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="hsl(var(--muted-foreground) / 0.12)"
        />
        <XAxis dataKey="name" hide />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tick={{ fontSize: 11 }}
          width={44}
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
                  {formatDuration(row.duration)}
                </div>
              </div>
            );
          }}
        />
        <Bar
          dataKey="durationSeconds"
          fill="var(--color-durationSeconds)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
          maxBarSize={52}
        />
      </BarChart>
    </ChartContainer>
  );
}

function TokensBarBlock({ data }: { data: TokensDatum[] }) {
  return (
    <ChartContainer
      config={{
        tokens: {
          label: "Tokens",
          color: "var(--chart-2)",
        },
      }}
      className="aspect-auto h-[min(120px,18vh)] w-full max-h-[140px]"
    >
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="hsl(var(--muted-foreground) / 0.12)"
        />
        <XAxis dataKey="name" hide />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tick={{ fontSize: 11 }}
          width={48}
          tickFormatter={(v: number) =>
            v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`
          }
        />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as TokensDatum;
            return (
              <div className="rounded-lg border bg-background p-2 shadow-sm">
                <div className="text-xs font-semibold">{row.name}</div>
                <div className="text-xs text-muted-foreground">
                  {Math.round(row.tokens).toLocaleString()} tokens (avg)
                </div>
              </div>
            );
          }}
        />
        <Bar
          dataKey="tokens"
          fill="var(--color-tokens)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
          maxBarSize={52}
        />
      </BarChart>
    </ChartContainer>
  );
}

const CHART_HINT = "Hover a bar for test names.";

/** Side-by-side duration / token bars with minimal chrome (one shared hint when both show). */
export function RunMetricsBarCharts({
  durationData,
  tokensData,
  hasTokenData,
}: RunMetricsBarChartsProps) {
  const showDuration = durationData.length > 0;
  const showTokens = hasTokenData;
  if (!showDuration && !showTokens) return null;

  const chartCount = (showDuration ? 1 : 0) + (showTokens ? 1 : 0);
  const singleChart = chartCount === 1;

  const durationSection = showDuration ? (
    <div className={cn("min-w-0", !singleChart && "lg:pr-4")}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Avg duration by test
        </h3>
        {singleChart ? (
          <span className="text-[10px] text-muted-foreground/60">
            {CHART_HINT}
          </span>
        ) : null}
      </div>
      <DurationBarBlock data={durationData} />
    </div>
  ) : null;

  const tokensSection = showTokens ? (
    <div className={cn("min-w-0", !singleChart && "lg:pl-4")}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Avg tokens by test
        </h3>
        {singleChart ? (
          <span className="text-[10px] text-muted-foreground/60">
            {CHART_HINT}
          </span>
        ) : null}
      </div>
      <TokensBarBlock data={tokensData} />
    </div>
  ) : null;

  if (singleChart) {
    return (
      <div className="mt-2 rounded-lg border border-border/25 bg-muted/10 p-3">
        {durationSection}
        {tokensSection}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-border/25 bg-muted/10 p-3">
      <p className="mb-3 text-[10px] text-muted-foreground/70">{CHART_HINT}</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-0 lg:divide-x lg:divide-border/30">
        {durationSection}
        {tokensSection}
      </div>
    </div>
  );
}
