import { Cell, Pie, PieChart } from "recharts";
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
import type { BarDatum } from "./UsageBarCard";

interface UsageDonutPairCardProps {
  title: string;
  leftLabel: string;
  leftData: BarDatum[];
  rightLabel: string;
  rightData: BarDatum[];
  onLeftSliceClick?: (datum: BarDatum) => void;
  onRightSliceClick?: (datum: BarDatum) => void;
  emptyState?: React.ReactNode;
}

const PALETTE = [
  "hsl(221 83% 53%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(291 64% 58%)",
  "hsl(199 89% 48%)",
  "hsl(0 72% 51%)",
];

const chartConfig = {} satisfies ChartConfig;

function Donut({
  data,
  onClick,
}: {
  data: BarDatum[];
  onClick?: (datum: BarDatum) => void;
}) {
  const hasData = data.length > 0 && data.some((d) => d.count > 0);
  // Same "only dim when something is selected" semantics as UsageBarCard so
  // donuts stay at full opacity with nothing active and visually highlight
  // the selected slice(s) otherwise.
  const hasSelection = data.some((d) => d.isSelected);

  if (!hasData) {
    return (
      <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
        No data
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="h-[180px] w-full">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Pie
          data={data}
          dataKey="count"
          nameKey="label"
          innerRadius={40}
          outerRadius={70}
          strokeWidth={2}
          onClick={(payload) => {
            if (!onClick) return;
            // Recharts Pie `onClick` exposes the original datum at `.payload`.
            const datum = (payload as any)?.payload as BarDatum | undefined;
            if (datum) onClick(datum);
          }}
          className={cn(onClick && "cursor-pointer")}
        >
          {data.map((entry, index) => (
            <Cell
              key={entry.key}
              fill={PALETTE[index % PALETTE.length]}
              stroke={
                entry.isSelected ? "var(--foreground)" : "var(--background)"
              }
              strokeWidth={entry.isSelected ? 3 : 2}
              opacity={!hasSelection || entry.isSelected ? 1 : 0.5}
            />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}

export function UsageDonutPairCard({
  title,
  leftLabel,
  leftData,
  rightLabel,
  rightData,
  onLeftSliceClick,
  onRightSliceClick,
  emptyState,
}: UsageDonutPairCardProps) {
  const hasAny =
    (leftData.length > 0 && leftData.some((d) => d.count > 0)) ||
    (rightData.length > 0 && rightData.some((d) => d.count > 0));

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid h-[220px] grid-cols-2 gap-4">
        {hasAny ? (
          <>
            <div className="flex flex-col items-center">
              <Donut data={leftData} onClick={onLeftSliceClick} />
              <span className="text-xs text-muted-foreground">{leftLabel}</span>
            </div>
            <div className="flex flex-col items-center">
              <Donut data={rightData} onClick={onRightSliceClick} />
              <span className="text-xs text-muted-foreground">
                {rightLabel}
              </span>
            </div>
          </>
        ) : (
          <div className="col-span-2 flex items-center justify-center text-center text-xs text-muted-foreground">
            {emptyState ?? "No data yet"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
