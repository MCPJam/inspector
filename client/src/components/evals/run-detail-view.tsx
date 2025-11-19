import { useState } from "react";
import { X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  BarChart,
  Bar,
  CartesianGrid,
  PieChart,
  Pie,
  XAxis,
  YAxis,
  Label,
} from "recharts";
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { IterationDetails } from "./iteration-details";
import { getIterationBorderColor } from "./helpers";
import { EvalIteration, EvalSuiteRun } from "./types";

interface RunDetailViewProps {
  selectedRunDetails: EvalSuiteRun;
  caseGroupsForSelectedRun: EvalIteration[];
  selectedRunChartData: {
    donutData: Array<{ name: string; value: number; fill: string }>;
    durationData: Array<{
      name: string;
      duration: number;
      durationSeconds: number;
    }>;
    tokensData: Array<{
      name: string;
      tokens: number;
    }>;
    modelData: Array<{
      model: string;
      passRate: number;
      passed: number;
      failed: number;
      total: number;
    }>;
  };
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
  showRunSummarySidebar: boolean;
  setShowRunSummarySidebar: (show: boolean) => void;
  serverNames?: string[];
}

export function RunDetailView({
  selectedRunDetails,
  caseGroupsForSelectedRun,
  selectedRunChartData,
  runDetailSortBy,
  onSortChange,
  showRunSummarySidebar,
  setShowRunSummarySidebar,
  serverNames = [],
}: RunDetailViewProps) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);

  return (
    <div className="relative">
      {/* Run Metrics and Chart */}
      <div className="rounded-lg border bg-background/80 px-3 py-2">
        <div className="flex items-center gap-6">
          {/* Metrics */}
          <div className="flex gap-6 flex-1">
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Accuracy</div>
              <div className="text-sm font-semibold">
                {selectedRunDetails.summary
                  ? `${Math.round(selectedRunDetails.summary.passRate * 100)}%`
                  : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Passed</div>
              <div className="text-sm font-semibold">
                {selectedRunDetails.summary?.passed.toLocaleString() ?? "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Failed</div>
              <div className="text-sm font-semibold">
                {selectedRunDetails.summary?.failed.toLocaleString() ?? "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-sm font-semibold">
                {selectedRunDetails.summary?.total.toLocaleString() ?? "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Duration</div>
              <div className="text-sm font-semibold">
                {selectedRunDetails.completedAt && selectedRunDetails.createdAt
                  ? formatDuration(
                      selectedRunDetails.completedAt -
                        selectedRunDetails.createdAt,
                    )
                  : "—"}
              </div>
            </div>
          </div>

          {/* Test Results Chart */}
          {selectedRunChartData.donutData.length > 0 && (
            <div className="flex items-center gap-2">
              <ChartContainer
                config={{
                  passed: { label: "Passed", color: "hsl(142.1 76.2% 36.3%)" },
                  failed: { label: "Failed", color: "hsl(0 84.2% 60.2%)" },
                  pending: { label: "Pending", color: "hsl(45.4 93.4% 47.5%)" },
                  cancelled: {
                    label: "Cancelled",
                    color: "hsl(240 3.7% 15.9%)",
                  },
                }}
                className="h-12 w-12"
              >
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie
                    data={selectedRunChartData.donutData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={15}
                    outerRadius={22}
                    strokeWidth={1}
                  >
                    <Label
                      content={({ viewBox }) => {
                        if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                          const total = selectedRunChartData.donutData.reduce(
                            (sum, item) => sum + item.value,
                            0,
                          );
                          return (
                            <text
                              x={viewBox.cx}
                              y={viewBox.cy}
                              textAnchor="middle"
                              dominantBaseline="middle"
                            >
                              <tspan
                                x={viewBox.cx}
                                y={viewBox.cy}
                                className="fill-foreground text-xs font-bold"
                              >
                                {total}
                              </tspan>
                              <tspan
                                x={viewBox.cx}
                                y={(viewBox.cy || 0) + 8}
                                className="fill-muted-foreground text-[8px]"
                              >
                                Total
                              </tspan>
                            </text>
                          );
                        }
                      }}
                    />
                  </Pie>
                </PieChart>
              </ChartContainer>
            </div>
          )}

          {/* Status */}
          <span className="text-xs font-medium text-foreground capitalize">
            {selectedRunDetails.status}
          </span>

          {/* Pass/Fail Badge */}
          <PassCriteriaBadge run={selectedRunDetails} variant="compact" />
        </div>
      </div>

      {/* Test Cases for this Run */}
      <div className="rounded-xl border bg-card text-card-foreground mt-4">
        <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold">All Iterations</div>
            <p className="text-xs text-muted-foreground">
              All test iterations from this run
            </p>
          </div>
          <select
            value={runDetailSortBy}
            onChange={(e) =>
              onSortChange(e.target.value as "model" | "test" | "result")
            }
            className="text-xs border rounded px-2 py-1 bg-background"
          >
            <option value="model">Sort by Model</option>
            <option value="test">Sort by Test</option>
            <option value="result">Sort by Result</option>
          </select>
        </div>

        {/* Column Headers */}
        {caseGroupsForSelectedRun.length > 0 && (
          <div className="flex items-center gap-4 w-full px-4 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground pl-7">
            <div className="flex-1">Test</div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="min-w-[120px]">Model</div>
              <div className="min-w-[50px]">Tools</div>
              <div className="min-w-[60px]">Tokens</div>
              <div className="min-w-[40px] text-right">Duration</div>
            </div>
          </div>
        )}

        <div className="divide-y">
          {caseGroupsForSelectedRun.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No test cases found for this run.
            </div>
          ) : (
            caseGroupsForSelectedRun.map((iteration) => (
              <IterationRow
                key={iteration._id}
                iteration={iteration}
                isOpen={openIterationId === iteration._id}
                onToggle={() =>
                  setOpenIterationId(
                    openIterationId === iteration._id ? null : iteration._id,
                  )
                }
                showModelInfo={true}
                serverNames={serverNames}
              />
            ))
          )}
        </div>
      </div>

      {/* Run Summary Sidebar */}
      {showRunSummarySidebar && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40 animate-in fade-in duration-200"
            onClick={() => setShowRunSummarySidebar(false)}
          />

          <div className="fixed right-0 top-0 bottom-0 w-[500px] bg-background border-l z-50 overflow-y-auto animate-in slide-in-from-right duration-300">
            <div className="sticky top-0 bg-background border-b px-4 py-3 flex items-center justify-between z-10">
              <div className="text-sm font-semibold">Run Summary</div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowRunSummarySidebar(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="p-4 space-y-4">
              {/* Charts */}
              {(selectedRunChartData.durationData.length > 0 ||
                selectedRunChartData.tokensData.length > 0 ||
                selectedRunChartData.modelData.length > 0) && (
                <div className="space-y-4">
                  {/* Duration per Test Bar Chart */}
                  {selectedRunChartData.durationData.length > 0 && (
                    <div className="rounded-lg border bg-background/50 p-4">
                      <div className="text-xs font-medium text-muted-foreground mb-3">
                        Duration per Test
                      </div>
                      <ChartContainer
                        config={{
                          duration: {
                            label: "Duration",
                            color: "var(--chart-1)",
                          },
                        }}
                        className="aspect-auto h-48 w-full"
                      >
                        <BarChart
                          data={selectedRunChartData.durationData}
                          width={undefined}
                          height={undefined}
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
                            tickMargin={8}
                            tick={{ fontSize: 11 }}
                            interval={0}
                            height={40}
                            tickFormatter={(value) => {
                              if (value.length > 15) {
                                return value.substring(0, 12) + "...";
                              }
                              return value;
                            }}
                          />
                          <YAxis
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => `${value.toFixed(1)}s`}
                          />
                          <ChartTooltip
                            cursor={false}
                            content={({ active, payload }) => {
                              if (!active || !payload || payload.length === 0)
                                return null;
                              const data = payload[0].payload;
                              return (
                                <div className="rounded-lg border bg-background p-2 shadow-sm">
                                  <div className="text-xs font-semibold">
                                    {data.name}
                                  </div>
                                  <div className="text-sm font-medium mt-1">
                                    {data.durationSeconds.toFixed(2)}s
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <Bar
                            dataKey="durationSeconds"
                            fill="var(--color-duration)"
                            radius={[4, 4, 0, 0]}
                            isAnimationActive={false}
                          />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}

                  {/* Tokens per Test Bar Chart */}
                  {selectedRunChartData.tokensData.length > 0 && (
                    <div className="rounded-lg border bg-background/50 p-4">
                      <div className="text-xs font-medium text-muted-foreground mb-3">
                        Tokens per Test
                      </div>
                      <ChartContainer
                        config={{
                          tokens: {
                            label: "Tokens",
                            color: "var(--chart-2)",
                          },
                        }}
                        className="aspect-auto h-48 w-full"
                      >
                        <BarChart
                          data={selectedRunChartData.tokensData}
                          width={undefined}
                          height={undefined}
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
                            tickMargin={8}
                            tick={{ fontSize: 11 }}
                            interval={0}
                            height={40}
                            tickFormatter={(value) => {
                              if (value.length > 15) {
                                return value.substring(0, 12) + "...";
                              }
                              return value;
                            }}
                          />
                          <YAxis
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => value.toLocaleString()}
                          />
                          <ChartTooltip
                            cursor={false}
                            content={({ active, payload }) => {
                              if (!active || !payload || payload.length === 0)
                                return null;
                              const data = payload[0].payload;
                              return (
                                <div className="rounded-lg border bg-background p-2 shadow-sm">
                                  <div className="text-xs font-semibold">
                                    {data.name}
                                  </div>
                                  <div className="text-sm font-medium mt-1">
                                    {Math.round(data.tokens).toLocaleString()}{" "}
                                    tokens
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
                          />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}

                  {/* Per-Model Performance for this run */}
                  {selectedRunChartData.modelData.length > 0 && (
                    <div className="rounded-lg border bg-background/50 p-4">
                      <div className="text-xs font-medium text-muted-foreground mb-3">
                        Performance by model
                      </div>
                      <ChartContainer
                        config={{
                          passRate: {
                            label: "Pass Rate",
                            color: "oklch(0.25 0 0)",
                          },
                        }}
                        className="aspect-auto h-48 w-full"
                      >
                        <BarChart
                          data={selectedRunChartData.modelData}
                          width={undefined}
                          height={undefined}
                        >
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
                            tickFormatter={(value) => {
                              if (value.length > 15) {
                                return value.substring(0, 12) + "...";
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
                            tickFormatter={(value) => `${value}%`}
                          />
                          <ChartTooltip
                            cursor={false}
                            content={({ active, payload }) => {
                              if (!active || !payload || payload.length === 0)
                                return null;
                              const data = payload[0].payload;
                              return (
                                <div className="rounded-lg border bg-background p-2 shadow-sm">
                                  <div className="grid gap-2">
                                    <div className="flex flex-col">
                                      <span className="text-xs font-semibold">
                                        {data.model}
                                      </span>
                                      <span className="text-xs text-muted-foreground mt-0.5">
                                        {data.passed} passed · {data.failed}{" "}
                                        failed
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <div
                                        className="h-2 w-2 rounded-full"
                                        style={{
                                          backgroundColor:
                                            "var(--color-passRate)",
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
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Simple iteration row component for flat list display
function IterationRow({
  iteration,
  isOpen,
  onToggle,
  showModelInfo = false,
  serverNames = [],
}: {
  iteration: EvalIteration;
  isOpen: boolean;
  onToggle: () => void;
  showModelInfo?: boolean;
  serverNames?: string[];
}) {
  const startedAt = iteration.startedAt ?? iteration.createdAt;
  const completedAt = iteration.updatedAt ?? iteration.createdAt;
  const durationMs =
    startedAt && completedAt ? Math.max(completedAt - startedAt, 0) : null;
  const isPending = iteration.result === "pending";

  const testInfo = iteration.testCaseSnapshot;
  const actualToolCalls = iteration.actualToolCalls || [];
  const modelName = testInfo?.model || "—";

  return (
    <div className={`relative ${isPending ? "opacity-60" : ""}`}>
      <div
        className={`absolute left-0 top-0 h-full w-1 ${getIterationBorderColor(
          iteration.result,
        )}`}
      />
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer hover:bg-muted/50"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3 pl-2">
          <div className="text-muted-foreground shrink-0">
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-xs font-medium truncate">
              {testInfo?.title || "Iteration"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
          {showModelInfo && (
            <div className="min-w-[120px] text-left truncate">
              <span className="font-mono text-xs">{modelName}</span>
            </div>
          )}
          <div className="min-w-[50px] text-center">
            <span className="font-mono">
              {isPending ? "—" : actualToolCalls.length}
            </span>
          </div>
          <div className="min-w-[60px] text-center">
            <span className="font-mono">
              {isPending
                ? "—"
                : Number(iteration.tokensUsed || 0).toLocaleString()}
            </span>
          </div>
          <div className="font-mono min-w-[40px] text-right">
            {isPending
              ? "—"
              : durationMs !== null
                ? formatDuration(durationMs)
                : "—"}
          </div>
          {isPending && (
            <div className="w-3.5 flex items-center justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
            </div>
          )}
        </div>
      </button>
      {isOpen ? (
        <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
          <IterationDetails
            iteration={iteration}
            testCase={null}
            serverNames={serverNames}
          />
        </div>
      ) : null}
    </div>
  );
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
