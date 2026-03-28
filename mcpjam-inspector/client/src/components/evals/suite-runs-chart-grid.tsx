import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { AccuracyChart } from "./accuracy-chart";

const modelChartConfig = {
  passRate: {
    label: "Pass Rate",
    color: "var(--chart-1)",
  },
};

export interface SuiteRunsChartGridProps {
  suiteSource?: "ui" | "sdk";
  runTrendData: Array<{
    runId: string;
    runIdDisplay: string;
    passRate: number;
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
  const metricLabel = isSdk ? "Pass Rate" : "Accuracy";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border bg-card text-card-foreground">
        <div className="px-4 pt-3 pb-2">
          <div className="text-xs font-medium text-muted-foreground">
            {isSdk ? "Pass Rate Trend" : "Accuracy Trend"}
          </div>
        </div>
        <div className="px-4 pb-4">
          <AccuracyChart
            data={runTrendData}
            isLoading={runsLoading}
            height="h-32"
            onClick={onRunClick}
            metricLabel={metricLabel}
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card text-card-foreground">
        <div className="px-4 pt-3 pb-2">
          <div className="text-xs font-medium text-muted-foreground">
            Performance by model
          </div>
        </div>
        <div className="px-4 pb-4">
          {modelStats.length > 1 ? (
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
                            <span className="text-xs text-muted-foreground mt-0.5">
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
          ) : (
            <p className="text-xs text-muted-foreground">
              No model data available.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
