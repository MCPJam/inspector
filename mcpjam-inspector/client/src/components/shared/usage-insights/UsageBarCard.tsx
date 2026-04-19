import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@mcpjam/design-system/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

export type BarDatum = {
  key: string;
  label: string;
  count: number;
  isSelected?: boolean;
};

interface UsageBarCardProps {
  title: string;
  description?: string;
  data: BarDatum[];
  onBarClick?: (datum: BarDatum) => void;
  emptyState?: React.ReactNode;
  /** Vertical (horizontal bars) is easier to read for many categories. */
  orientation?: "horizontal" | "vertical";
}

const chartConfig = {
  count: {
    label: "Sessions",
    color: "var(--primary, hsl(var(--primary)))",
  },
} satisfies ChartConfig;

export function UsageBarCard({
  title,
  description,
  data,
  onBarClick,
  emptyState,
  orientation = "vertical",
}: UsageBarCardProps) {
  const hasData = data.length > 0;
  // hasSelection is a property of the whole dataset, not each datum — compute
  // once per render instead of O(n) on every map iteration.
  const hasSelection = data.some((d) => d.isSelected);

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>
      <CardContent className="flex h-[220px] items-center justify-center">
        {hasData ? (
          <ChartContainer config={chartConfig} className="h-full w-full">
            <BarChart
              accessibilityLayer
              data={data}
              layout={orientation === "vertical" ? "vertical" : "horizontal"}
              margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={orientation === "horizontal"}
                horizontal={orientation === "vertical"}
              />
              {orientation === "vertical" ? (
                <>
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={100}
                    tick={{ fontSize: 11 }}
                  />
                </>
              ) : (
                <>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                </>
              )}
              <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
              <Bar
                dataKey="count"
                fill="var(--color-count)"
                radius={3}
                onClick={(payload) => {
                  if (!onBarClick) return;
                  const datum = payload?.payload as BarDatum | undefined;
                  if (datum) onBarClick(datum);
                }}
                className={cn(onBarClick && "cursor-pointer")}
              >
                {data.map((datum) => (
                  // When nothing is selected, render every bar at full opacity.
                  // Only dim unselected bars when the chart has an active selection.
                  <Cell
                    key={datum.key}
                    fill="var(--color-count)"
                    opacity={!hasSelection || datum.isSelected ? 1 : 0.5}
                    stroke={datum.isSelected ? "var(--color-count)" : undefined}
                    strokeWidth={datum.isSelected ? 2 : 0}
                  />
                ))}
              </Bar>
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
