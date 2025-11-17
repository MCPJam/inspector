import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

interface AccuracyChartData {
  runId?: string;
  runIdDisplay: string;
  passRate: number;
  label?: string;
}

interface AccuracyChartProps {
  data: AccuracyChartData[];
  isLoading?: boolean;
  title?: string;
  height?: string;
  onClick?: (runId: string) => void;
  showLabel?: boolean;
}

export function AccuracyChart({
  data,
  isLoading = false,
  title,
  height = "h-32",
  onClick,
  showLabel = false,
}: AccuracyChartProps) {
  if (isLoading) {
    return <Skeleton className={`${height} w-full`} />;
  }

  if (data.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No completed runs yet.</p>
    );
  }

  return (
    <ChartContainer
      config={{
        passRate: {
          label: "Pass rate",
          color: "var(--chart-1)",
        },
      }}
      className={`aspect-auto ${height} w-full`}
    >
      <AreaChart
        data={data}
        width={undefined}
        height={undefined}
        onClick={
          onClick
            ? (chartData: any) => {
                if (chartData?.activePayload?.[0]?.payload?.runId) {
                  onClick(chartData.activePayload[0].payload.runId);
                }
              }
            : undefined
        }
      >
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="hsl(var(--muted-foreground) / 0.2)"
        />
        <XAxis
          dataKey="runIdDisplay"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tick={{ fontSize: showLabel ? 11 : 12 }}
          label={
            showLabel
              ? {
                  value: "Run",
                  position: "insideBottom",
                  offset: -5,
                  fontSize: 11,
                }
              : undefined
          }
        />
        <YAxis
          domain={[0, 100]}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tick={{ fontSize: showLabel ? 11 : 12 }}
          tickFormatter={(value) => `${value}%`}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Area
          type="monotone"
          dataKey="passRate"
          stroke="var(--color-passRate)"
          fill="var(--color-passRate)"
          fillOpacity={0.15}
          strokeWidth={2}
          isAnimationActive={false}
          dot={
            data.length > 1 ? (onClick ? { cursor: "pointer" } : true) : false
          }
          activeDot={onClick ? { cursor: "pointer", r: 6 } : undefined}
        />
      </AreaChart>
    </ChartContainer>
  );
}
