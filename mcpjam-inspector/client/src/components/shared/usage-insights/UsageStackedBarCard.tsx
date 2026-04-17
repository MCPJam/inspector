import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export type StackedDatum = {
  key: string;
  label: string;
  positive: number;
  neutral: number;
  negative: number;
  none: number;
};

interface UsageStackedBarCardProps {
  title: string;
  description?: string;
  data: StackedDatum[];
  onSegmentClick?: (datum: StackedDatum) => void;
  emptyState?: React.ReactNode;
}

const chartConfig = {
  positive: { label: "Positive", color: "hsl(142 71% 45%)" },
  neutral: { label: "Neutral", color: "hsl(210 16% 58%)" },
  negative: { label: "Negative", color: "hsl(0 72% 51%)" },
  none: { label: "No feedback", color: "hsl(220 13% 78%)" },
} satisfies ChartConfig;

export function UsageStackedBarCard({
  title,
  description,
  data,
  onSegmentClick,
  emptyState,
}: UsageStackedBarCardProps) {
  const hasData =
    data.length > 0 &&
    data.some(
      (d) => d.positive + d.neutral + d.negative + d.none > 0,
    );

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>
      <CardContent className="flex h-[240px] items-center justify-center">
        {hasData ? (
          <ChartContainer config={chartConfig} className="h-full w-full">
            <BarChart
              accessibilityLayer
              data={data}
              margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
              <Legend
                wrapperStyle={{ fontSize: 10 }}
                iconSize={8}
                iconType="square"
              />
              {(["positive", "neutral", "negative", "none"] as const).map(
                (key) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="feedback"
                    fill={`var(--color-${key})`}
                    radius={0}
                    onClick={(payload) => {
                      if (!onSegmentClick) return;
                      const datum = payload?.payload as StackedDatum | undefined;
                      if (datum) onSegmentClick(datum);
                    }}
                  />
                ),
              )}
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="text-center text-xs text-muted-foreground">
            {emptyState ?? "No data yet"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
