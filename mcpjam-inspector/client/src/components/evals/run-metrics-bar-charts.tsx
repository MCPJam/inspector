import { ChevronDown } from "lucide-react";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
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
      <BarChart
        data={data}
        margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="hsl(var(--muted-foreground) / 0.2)"
        />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tick={{ fontSize: 11 }}
          interval={0}
          height={72}
          angle={-24}
          textAnchor="end"
          tickFormatter={(v: string) =>
            v.length > 24 ? `${v.substring(0, 22)}…` : v
          }
        />
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
      <BarChart
        data={data}
        margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="hsl(var(--muted-foreground) / 0.2)"
        />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tick={{ fontSize: 11 }}
          interval={0}
          height={72}
          angle={-24}
          textAnchor="end"
          tickFormatter={(v: string) =>
            v.length > 24 ? `${v.substring(0, 22)}…` : v
          }
        />
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

/** In-card collapsible charts (default collapsed). Full-width stacked charts when expanded. */
export function RunMetricsBarCharts({
  durationData,
  tokensData,
  hasTokenData,
}: RunMetricsBarChartsProps) {
  const showDuration = durationData.length > 0;
  const showTokens = hasTokenData;
  if (!showDuration && !showTokens) return null;

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <Collapsible defaultOpen={false} className="group">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-md py-2 -mx-1 px-1 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60">
          <span className="text-xs font-medium text-muted-foreground">
            Duration and token charts
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4 space-y-10">
          {showDuration && (
            <div className="min-w-0 w-full">
              <h3 className="text-sm font-semibold text-foreground mb-3">
                Avg duration by test
              </h3>
              <DurationBarBlock data={durationData} />
            </div>
          )}
          {showTokens && (
            <div className="min-w-0 w-full">
              <h3 className="text-sm font-semibold text-foreground mb-3">
                Avg tokens by test
              </h3>
              <TokensBarBlock data={tokensData} />
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
