import { useMemo } from "react";
import { X, Loader2 } from "lucide-react";
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
import {
  computeIterationResult,
  computeIterationPassed,
} from "./pass-criteria";
import { EvalIteration, EvalSuiteRun } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";

interface RunDetailViewProps {
  selectedRunDetails: EvalSuiteRun;
  caseGroupsForSelectedRun: EvalIteration[];
  source?: "ui" | "sdk";
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
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
}

export function RunDetailView({
  selectedRunDetails,
  caseGroupsForSelectedRun,
  source,
  selectedRunChartData,
  runDetailSortBy,
  onSortChange,
  showRunSummarySidebar,
  setShowRunSummarySidebar,
  serverNames = [],
  selectedIterationId,
  onSelectIteration,
}: RunDetailViewProps) {
  // Compute accurate pass/fail stats using the same logic as suite-header
  const computedStats = useMemo(() => {
    if (caseGroupsForSelectedRun.length === 0) {
      return (
        selectedRunDetails.summary ?? {
          passed: 0,
          failed: 0,
          total: 0,
          passRate: 0,
        }
      );
    }
    const passed = caseGroupsForSelectedRun.filter((i) =>
      computeIterationPassed(i),
    ).length;
    const failed = caseGroupsForSelectedRun.filter(
      (i) => !computeIterationPassed(i),
    ).length;
    const total = caseGroupsForSelectedRun.length;
    const passRate = total > 0 ? passed / total : 0;
    return { passed, failed, total, passRate };
  }, [caseGroupsForSelectedRun, selectedRunDetails.summary]);

  const hasTokenData = useMemo(
    () => caseGroupsForSelectedRun.some((i) => (i.tokensUsed || 0) > 0),
    [caseGroupsForSelectedRun],
  );

  const isRunning = selectedRunDetails.status === "running";
  const expected = selectedRunDetails.expectedIterations;
  const donutTotal = selectedRunChartData.donutData.reduce(
    (sum, item) => sum + item.value,
    0,
  );
  const remaining = useMemo(() => {
    if (expected && isRunning && expected > donutTotal) {
      return expected - donutTotal;
    }
    return 0;
  }, [expected, isRunning, donutTotal]);

  const progressDonutData = useMemo(() => {
    if (remaining > 0) {
      return [
        ...selectedRunChartData.donutData,
        { name: "remaining", value: remaining, fill: "hsl(240 3.7% 15.9% / 0.3)" },
      ];
    }
    return selectedRunChartData.donutData;
  }, [selectedRunChartData.donutData, remaining]);

  const progressPercent = expected && expected > 0
    ? Math.round((donutTotal / expected) * 100)
    : null;

  const metricLabel = source === "sdk" ? "Pass Rate" : "Accuracy";

  const selectedIteration = useMemo(
    () =>
      selectedIterationId
        ? caseGroupsForSelectedRun.find((i) => i._id === selectedIterationId) ?? null
        : null,
    [selectedIterationId, caseGroupsForSelectedRun],
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* Run Header (sticky) */}
      <div className="sticky top-0 z-10 bg-background shrink-0">
        {(selectedRunDetails.ciMetadata?.branch ||
          selectedRunDetails.ciMetadata?.commitSha ||
          selectedRunDetails.ciMetadata?.runUrl) && (
          <div className="mb-4">
            <CiMetadataDisplay ciMetadata={selectedRunDetails.ciMetadata} />
          </div>
        )}

        {/* Run Metrics and Chart */}
        <div className="rounded-lg border bg-background/80 px-3 py-2">
          <div className="flex items-center gap-6">
            {/* Metrics */}
            <div className="flex gap-6 flex-1">
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">{metricLabel}</div>
                <div className="text-sm font-semibold">
                  {computedStats.total > 0
                    ? `${Math.round(computedStats.passRate * 100)}%`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">Passed</div>
                <div className="text-sm font-semibold">
                  {computedStats.passed.toLocaleString()}
                </div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">Failed</div>
                <div className="text-sm font-semibold">
                  {computedStats.failed.toLocaleString()}
                </div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">Total</div>
                <div className="text-sm font-semibold">
                  {expected && isRunning
                    ? `${computedStats.total.toLocaleString()} / ${expected.toLocaleString()}`
                    : computedStats.total.toLocaleString()}
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
                    remaining: {
                      label: "Remaining",
                      color: "hsl(240 3.7% 15.9% / 0.3)",
                    },
                  }}
                  className="h-12 w-12"
                >
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                    <Pie
                      data={progressDonutData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={15}
                      outerRadius={22}
                      strokeWidth={1}
                    >
                      <Label
                        content={({ viewBox }) => {
                          if (viewBox && "cx" in viewBox && "cy" in viewBox) {
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
                                  {expected && isRunning
                                    ? `${donutTotal}/${expected}`
                                    : donutTotal}
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
              {isRunning && progressPercent !== null
                ? `Running (${progressPercent}%)`
                : selectedRunDetails.status}
            </span>

            {/* Pass/Fail Badge */}
            <PassCriteriaBadge run={selectedRunDetails} variant="compact" metricLabel={metricLabel} />
          </div>
        </div>
      </div>

      {/* Two-pane body */}
      <div className="flex h-0 flex-1 mt-4 gap-0 rounded-xl border bg-card text-card-foreground overflow-hidden">
        {/* Left pane: iteration list */}
        <div className="w-[280px] shrink-0 border-r flex flex-col">
          <div className="border-b px-3 py-2 shrink-0 flex items-center justify-between">
            <div className="text-xs font-semibold">Iterations</div>
            <select
              value={runDetailSortBy}
              onChange={(e) =>
                onSortChange(e.target.value as "model" | "test" | "result")
              }
              className="text-[10px] border rounded px-1.5 py-0.5 bg-background"
            >
              <option value="model">Model</option>
              <option value="test">Test</option>
              <option value="result">Result</option>
            </select>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="divide-y">
              {caseGroupsForSelectedRun.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No iterations found.
                </div>
              ) : (
                caseGroupsForSelectedRun.map((iteration) => (
                  <IterationListItem
                    key={iteration._id}
                    iteration={iteration}
                    isSelected={selectedIterationId === iteration._id}
                    onSelect={() => onSelectIteration(iteration._id)}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right pane: iteration detail */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selectedIteration ? (
            <div key={selectedIterationId} className="flex-1 min-h-0 overflow-y-auto p-4">
              <IterationDetails
                iteration={selectedIteration}
                testCase={null}
                serverNames={serverNames}
                layoutMode="full"
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-sm text-muted-foreground">
                {caseGroupsForSelectedRun.length === 0
                  ? "No iterations in this run yet."
                  : "Select an iteration to view details"}
              </div>
            </div>
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
                        className="aspect-auto h-64 w-full"
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
                            tick={{
                              fontSize: 10,
                              angle: -45,
                              textAnchor: "end",
                            }}
                            interval={0}
                            height={80}
                            tickFormatter={(value) => {
                              if (value.length > 20) {
                                return value.substring(0, 17) + "...";
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
                        className="aspect-auto h-64 w-full"
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
                            tick={{
                              fontSize: 10,
                              angle: -45,
                              textAnchor: "end",
                            }}
                            interval={0}
                            height={80}
                            tickFormatter={(value) => {
                              if (value.length > 20) {
                                return value.substring(0, 17) + "...";
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
                  {selectedRunChartData.modelData.length > 1 && (
                    <div className="rounded-lg border bg-background/50 p-4">
                      <div className="text-xs font-medium text-muted-foreground mb-3">
                        Performance by model
                      </div>
                      <ChartContainer
                        config={{
                          passRate: {
                            label: metricLabel,
                            color: "var(--chart-1)",
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

// Compact iteration list item for the left pane
function IterationListItem({
  iteration,
  isSelected,
  onSelect,
}: {
  iteration: EvalIteration;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const startedAt = iteration.startedAt ?? iteration.createdAt;
  const completedAt = iteration.updatedAt ?? iteration.createdAt;
  const durationMs =
    startedAt && completedAt ? Math.max(completedAt - startedAt, 0) : null;
  const isPending =
    iteration.status === "pending" || iteration.status === "running";

  const testInfo = iteration.testCaseSnapshot;
  const modelName = testInfo?.model || "—";

  const computedResult = computeIterationResult(iteration);

  return (
    <div className={`relative ${isPending ? "opacity-60" : ""}`}>
      <div
        className={`absolute left-0 top-0 h-full w-1 ${getIterationBorderColor(
          computedResult,
        )}`}
      />
      <button
        onClick={onSelect}
        className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer ${
          isSelected
            ? "bg-primary/10 border-r-2 border-r-primary"
            : "hover:bg-muted/50"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium truncate flex-1">
            {testInfo?.title || "Iteration"}
          </span>
          {isPending && (
            <Loader2 className="h-3 w-3 animate-spin text-warning shrink-0" />
          )}
          {testInfo?.isNegativeTest && (
            <span
              className="text-[10px] text-orange-500 shrink-0"
              title="Negative test"
            >
              NEG
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-mono truncate">{modelName}</span>
          <span className="shrink-0">
            {isPending
              ? "—"
              : durationMs !== null
                ? formatDuration(durationMs)
                : "—"}
          </span>
        </div>
      </button>
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
