import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { BarChart, Bar, CartesianGrid, XAxis, YAxis } from "recharts";
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
      className="aspect-auto h-[min(400px,50vh)] w-full"
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
      className="aspect-auto h-[min(400px,50vh)] w-full"
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

/** Railway-style chart cards — always visible, side-by-side grid. */
export function RunMetricsBarCharts({
  durationData,
  tokensData,
  hasTokenData,
}: RunMetricsBarChartsProps) {
  const showDuration = durationData.length > 0;
  const showTokens = hasTokenData;
  if (!showDuration && !showTokens) return null;

  const singleChart = (showDuration ? 1 : 0) + (showTokens ? 1 : 0) === 1;

  return (
    <div
      className={
        singleChart
          ? "mt-2 grid grid-cols-1 gap-3"
          : "mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2"
      }
    >
      {showDuration && (
        <div className="rounded-xl border border-border/40 bg-card/80 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Avg duration by test
            </h3>
            <span className="text-[10px] text-muted-foreground/60">
              Hover bars to see test names
            </span>
          </div>
          <DurationBarBlock data={durationData} />
        </div>
      )}
      {showTokens && (
        <div className="rounded-xl border border-border/40 bg-card/80 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Avg tokens by test
            </h3>
            <span className="text-[10px] text-muted-foreground/60">
              Hover bars to see test names
            </span>
          </div>
          <TokensBarBlock data={tokensData} />
        </div>
      )}
    </div>
  );
}
