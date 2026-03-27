import { useMemo } from "react";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  PieChart,
  Pie,
  Label,
} from "recharts";
import { cn } from "@/lib/utils";
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { IterationDetails } from "./iteration-details";
import {
  evalStatusLeftBorderClasses,
  formatDuration,
  formatRunId,
} from "./helpers";
import { RunMetricsBarCharts } from "./run-metrics-bar-charts";
import {
  computeIterationResult,
  computeIterationPassed,
} from "./pass-criteria";
import { EvalIteration, EvalSuiteRun } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { AiTriagePanel } from "./ai-triage-panel";

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
  serverNames?: string[];
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  hideCiMetadata?: boolean;
  /** When true, omit replay source line (shown in SuiteHeader instead). */
  hideReplayLineage?: boolean;
  /** When true, only the iteration detail pane is shown (list lives in a parent sidebar). */
  omitIterationList?: boolean;
}

function IterationListItem({
  iteration,
  isSelected,
  onSelect,
}: {
  iteration: EvalIteration;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const isPending =
    iteration.status === "pending" || iteration.status === "running";

  const testInfo = iteration.testCaseSnapshot;
  const modelName = testInfo?.model || "—";

  const computedResult = computeIterationResult(iteration);

  return (
    <div
      className={cn(
        "relative border-l-2",
        evalStatusLeftBorderClasses(
          isPending ? "running" : computedResult,
        ),
        isPending && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={
          testInfo?.isNegativeTest
            ? "Negative test — expects the tool NOT to be called"
            : undefined
        }
        aria-label={
          testInfo?.isNegativeTest
            ? `Negative test (expects the tool not to be called): ${testInfo?.title || "Iteration"}, ${modelName}`
            : undefined
        }
        className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer ${
          isSelected
            ? "bg-primary/10 border-r-2 border-r-primary"
            : "hover:bg-muted/50"
        }`}
      >
        <span className="text-xs font-medium leading-snug line-clamp-2">
          {testInfo?.title || "Iteration"}
        </span>
        <span className="truncate text-[10px] font-mono text-muted-foreground">
          {modelName}
        </span>
      </button>
    </div>
  );
}

function IterationListWithSections({
  iterations,
  sortBy,
  selectedIterationId,
  onSelectIteration,
}: {
  iterations: EvalIteration[];
  sortBy: "model" | "test" | "result";
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
}) {
  if (sortBy !== "result") {
    return (
      <>
        {iterations.map((iteration) => (
          <IterationListItem
            key={iteration._id}
            iteration={iteration}
            isSelected={selectedIterationId === iteration._id}
            onSelect={() => onSelectIteration(iteration._id)}
          />
        ))}
      </>
    );
  }

  const failing = iterations.filter(
    (i) => computeIterationResult(i) === "failed",
  );
  const passing = iterations.filter(
    (i) => computeIterationResult(i) === "passed",
  );
  const other = iterations.filter((i) => {
    const r = computeIterationResult(i);
    return r !== "failed" && r !== "passed";
  });

  const ordered = [...failing, ...passing, ...other];

  return (
    <>
      {ordered.map((iteration) => (
        <IterationListItem
          key={iteration._id}
          iteration={iteration}
          isSelected={selectedIterationId === iteration._id}
          onSelect={() => onSelectIteration(iteration._id)}
        />
      ))}
    </>
  );
}

/** Iteration list + sort (used inside run detail or the CI Runs drilldown sidebar). */
export function RunIterationsSidebar({
  caseGroupsForSelectedRun,
  runDetailSortBy,
  onSortChange,
  selectedIterationId,
  onSelectIteration,
}: {
  caseGroupsForSelectedRun: EvalIteration[];
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="text-xs font-semibold">Iterations</div>
        <select
          value={runDetailSortBy}
          onChange={(e) =>
            onSortChange(e.target.value as "model" | "test" | "result")
          }
          className="rounded border bg-background px-1.5 py-0.5 text-[10px]"
          aria-label="Sort iterations"
        >
          <option value="model">Model</option>
          <option value="test">Test</option>
          <option value="result">Result</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="divide-y">
          {caseGroupsForSelectedRun.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              No iterations found.
            </div>
          ) : (
            <IterationListWithSections
              iterations={caseGroupsForSelectedRun}
              sortBy={runDetailSortBy}
              selectedIterationId={selectedIterationId}
              onSelectIteration={onSelectIteration}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function RunDetailView({
  selectedRunDetails,
  caseGroupsForSelectedRun,
  source,
  selectedRunChartData,
  runDetailSortBy,
  onSortChange,
  serverNames = [],
  selectedIterationId,
  onSelectIteration,
  hideCiMetadata,
  hideReplayLineage,
  omitIterationList = false,
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
        {
          name: "remaining",
          value: remaining,
          fill: "hsl(240 3.7% 15.9% / 0.3)",
        },
      ];
    }
    return selectedRunChartData.donutData;
  }, [selectedRunChartData.donutData, remaining]);

  const progressPercent =
    expected && expected > 0 ? Math.round((donutTotal / expected) * 100) : null;

  const metricLabel = source === "sdk" ? "Pass Rate" : "Accuracy";

  const selectedIteration = useMemo(
    () =>
      selectedIterationId
        ? (caseGroupsForSelectedRun.find(
            (i) => i._id === selectedIterationId,
          ) ?? null)
        : null,
    [selectedIterationId, caseGroupsForSelectedRun],
  );

  const hasTokenData = useMemo(
    () =>
      selectedRunChartData.tokensData.length > 0 &&
      selectedRunChartData.tokensData.some((d) => d.tokens > 0),
    [selectedRunChartData.tokensData],
  );

  const hasRunBarCharts =
    selectedRunChartData.durationData.length > 0 || hasTokenData;

  return (
    <div
      className={cn(
        "relative flex flex-col p-4",
        omitIterationList && "min-h-0 flex-1 overflow-hidden",
      )}
    >
      {/* Run Header */}
      <div className="shrink-0">
        {!hideCiMetadata &&
          (selectedRunDetails.ciMetadata?.branch ||
            selectedRunDetails.ciMetadata?.commitSha ||
            selectedRunDetails.ciMetadata?.runUrl) && (
            <div className="mb-4">
              <CiMetadataDisplay ciMetadata={selectedRunDetails.ciMetadata} />
            </div>
          )}

        {!hideReplayLineage && selectedRunDetails.replayedFromRunId ? (
          <p
            className="mb-4 text-xs text-muted-foreground"
            title={selectedRunDetails.replayedFromRunId}
          >
            Replay of{" "}
            <span className="font-mono text-foreground/90">
              Run {formatRunId(selectedRunDetails.replayedFromRunId)}
            </span>
          </p>
        ) : null}

        {/* Run Metrics and Chart */}
        <div className="rounded-lg border bg-background/80 px-3 py-2">
          <div className="flex items-center gap-6">
            {/* Metrics */}
            <div className="flex gap-6 flex-1 min-w-0">
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">
                  {metricLabel}
                </div>
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
                  {selectedRunDetails.completedAt &&
                  selectedRunDetails.createdAt
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
              <div className="flex items-center gap-2 shrink-0">
                <ChartContainer
                  config={{
                    passed: {
                      label: "Passed",
                      color: "hsl(142.1 76.2% 36.3%)",
                    },
                    failed: { label: "Failed", color: "hsl(0 84.2% 60.2%)" },
                    pending: {
                      label: "Pending",
                      color: "hsl(45.4 93.4% 47.5%)",
                    },
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
            <span className="text-xs font-medium text-foreground capitalize shrink-0">
              {isRunning && progressPercent !== null
                ? `Running (${progressPercent}%)`
                : selectedRunDetails.status}
            </span>

            {/* Pass/Fail Badge */}
            <PassCriteriaBadge
              run={selectedRunDetails}
              variant="compact"
              metricLabel={metricLabel}
            />
          </div>

          {/* Inline model performance (only when ≥2 models) */}
          {selectedRunChartData.modelData.length >= 2 && (
            <div className="flex flex-wrap items-center gap-4 mt-2 pt-2 border-t border-border/50">
              <span className="text-[10px] text-muted-foreground">
                By Model:
              </span>
              {selectedRunChartData.modelData.map((model) => (
                <div key={model.model} className="flex items-center gap-1.5">
                  <div
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor:
                        model.passRate >= 80
                          ? "hsl(142.1 76.2% 36.3%)"
                          : model.passRate >= 50
                            ? "hsl(45.4 93.4% 47.5%)"
                            : "hsl(0 84.2% 60.2%)",
                    }}
                  />
                  <span className="text-[11px]">{model.model}</span>
                  <span className="text-[11px] font-mono font-medium">
                    {model.passRate}%
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    ({model.passed}/{model.total})
                  </span>
                </div>
              ))}
            </div>
          )}

          {hasRunBarCharts && (
            <RunMetricsBarCharts
              durationData={selectedRunChartData.durationData}
              tokensData={selectedRunChartData.tokensData}
              hasTokenData={hasTokenData}
            />
          )}
        </div>
      </div>

      {/* AI Triage — shown between summary and iteration panes */}
      <AiTriagePanel
        run={selectedRunDetails}
        failedCount={computedStats.failed}
      />

      {/* Iteration list + detail (list may live in a parent sidebar when omitIterationList). */}
      <div
        className={cn(
          "mt-4 flex gap-0 overflow-hidden rounded-xl border bg-card text-card-foreground",
          omitIterationList ? "min-h-0 flex-1 flex-col" : "",
        )}
        style={
          omitIterationList
            ? { minHeight: "400px" }
            : { height: "calc(100vh - 200px)", minHeight: "400px" }
        }
      >
        {!omitIterationList ? (
          <div className="flex w-[280px] shrink-0 flex-col border-r">
            <RunIterationsSidebar
              caseGroupsForSelectedRun={caseGroupsForSelectedRun}
              runDetailSortBy={runDetailSortBy}
              onSortChange={onSortChange}
              selectedIterationId={selectedIterationId}
              onSelectIteration={onSelectIteration}
            />
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selectedIteration ? (
            <div
              key={selectedIterationId}
              className="flex-1 min-h-0 overflow-y-auto p-4"
            >
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
    </div>
  );
}
