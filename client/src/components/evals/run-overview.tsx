import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { AccuracyChart } from "./accuracy-chart";
import { formatRunId, getIterationBorderColor } from "./helpers";
import { computeIterationResult } from "./pass-criteria";
import { EvalIteration, EvalSuiteRun } from "./types";
import { toast } from "sonner";

interface RunOverviewProps {
  suite: { _id: string; name: string };
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  allIterations: EvalIteration[];
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
  onRunClick: (runId: string) => void;
  onDirectDeleteRun: (runId: string) => Promise<void>;
  runsViewMode: "runs" | "test-cases";
  onViewModeChange: (value: "runs" | "test-cases") => void;
}

export function RunOverview({
  suite,
  runs,
  runsLoading,
  allIterations,
  runTrendData,
  modelStats,
  onRunClick,
  onDirectDeleteRun,
  runsViewMode,
  onViewModeChange,
}: RunOverviewProps) {
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteModal, setShowBatchDeleteModal] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  const toggleRunSelection = useCallback((runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }, []);

  const toggleAllRuns = useCallback(() => {
    setSelectedRunIds((prev) => {
      if (prev.size === runs.length) {
        return new Set();
      } else {
        return new Set(runs.map((r) => r._id));
      }
    });
  }, [runs]);

  const confirmBatchDeleteRuns = useCallback(() => {
    const runIds = Array.from(selectedRunIds);
    if (runIds.length === 0) return;

    setDeletingRunId("batch");
    Promise.all(runIds.map((runId) => onDirectDeleteRun(runId)))
      .then(() => {
        setSelectedRunIds(new Set());
        setShowBatchDeleteModal(false);
        toast.success(`Deleted ${runIds.length} run(s) successfully`);
      })
      .catch((error) => {
        console.error("Failed to delete runs:", error);
        toast.error("Failed to delete some runs");
      })
      .finally(() => {
        setDeletingRunId(null);
        setShowBatchDeleteModal(false);
      });
  }, [selectedRunIds, onDirectDeleteRun]);

  const modelChartConfig = {
    passRate: {
      label: "Pass Rate",
      color: "var(--chart-1)",
    },
  };

  return (
    <>
      {/* Charts Side by Side */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Accuracy */}
        <div className="rounded-xl border bg-card text-card-foreground">
          <div className="px-4 pt-3 pb-2">
            <div className="text-xs font-medium text-muted-foreground">
              Accuracy
            </div>
          </div>
          <div className="px-4 pb-4">
            <AccuracyChart
              data={runTrendData}
              isLoading={runsLoading}
              height="h-32"
              onClick={onRunClick}
            />
          </div>
        </div>

        {/* Per-Model Performance */}
        <div className="rounded-xl border bg-card text-card-foreground">
          <div className="px-4 pt-3 pb-2">
            <div className="text-xs font-medium text-muted-foreground">
              Performance by model
            </div>
          </div>
          <div className="px-4 pb-4">
            {modelStats.length > 0 ? (
              <ChartContainer
                config={modelChartConfig}
                className="aspect-auto h-32 w-full"
              >
                <BarChart
                  data={modelStats}
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

      {/* Runs List */}
      <div className="rounded-xl border bg-card text-card-foreground flex flex-col max-h-[600px]">
        {selectedRunIds.size > 0 ? (
          <div className="border-b px-4 py-2 shrink-0 bg-muted/50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={selectedRunIds.size === runs.length}
                onCheckedChange={toggleAllRuns}
                aria-label="Select all runs"
              />
              <span className="text-xs font-medium">
                {selectedRunIds.size}{" "}
                {selectedRunIds.size === 1 ? "item" : "items"} selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedRunIds(new Set())}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowBatchDeleteModal(true)}
                disabled={deletingRunId !== null}
              >
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">
                Click on a run to view its test breakdown and results.
              </p>
            </div>
            <select
              value={runsViewMode}
              onChange={(e) =>
                onViewModeChange(e.target.value as "runs" | "test-cases")
              }
              className="text-xs border rounded px-2 py-1 bg-background"
            >
              <option value="runs">Runs</option>
              <option value="test-cases">Test Cases</option>
            </select>
          </div>
        )}

        {/* Column Headers */}
        {runs.length > 0 && (
          <div className="flex items-center gap-6 w-full px-4 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground">
            <div className="w-4"></div>
            <div className="min-w-[120px]">Run ID</div>
            <div className="min-w-[140px]">Start time</div>
            <div className="min-w-[60px]">Duration</div>
            <div className="min-w-[60px] text-right">Passed</div>
            <div className="min-w-[60px] text-right">Failed</div>
            <div className="min-w-[70px] text-right">Accuracy</div>
            <div className="min-w-[70px] text-right">Tokens</div>
          </div>
        )}

        <div className="divide-y overflow-y-auto">
          {runs.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No runs found.
            </div>
          ) : (
            runs.map((run) => {
              const runIterations = allIterations.filter(
                (iter) => iter.suiteRunId === run._id,
              );
              // Only count completed iterations - exclude pending/cancelled
              const iterationResults = runIterations.map((i) =>
                computeIterationResult(i),
              );
              const realTimePassed = iterationResults.filter(
                (r) => r === "passed",
              ).length;
              const realTimeFailed = iterationResults.filter(
                (r) => r === "failed",
              ).length;
              const realTimeTotal = realTimePassed + realTimeFailed;
              const totalTokens = runIterations.reduce(
                (sum, iter) => sum + (iter.tokensUsed || 0),
                0,
              );

              const passed =
                realTimePassed > 0
                  ? realTimePassed
                  : (run.summary?.passed ?? 0);
              const failed =
                realTimeFailed > 0
                  ? realTimeFailed
                  : (run.summary?.failed ?? 0);
              const total =
                realTimeTotal > 0 ? realTimeTotal : (run.summary?.total ?? 0);
              const passRate =
                total > 0 ? Math.round((passed / total) * 100) : null;

              const timestamp = formatTime(run.completedAt ?? run.createdAt);

              const duration =
                run.completedAt && run.createdAt
                  ? formatDuration(run.completedAt - run.createdAt)
                  : run.createdAt && run.status === "running"
                    ? formatDuration(Date.now() - run.createdAt)
                    : "—";

              const isInactive = run.isActive === false;

              const runResult =
                run.result ||
                (run.status === "completed" && passRate !== null
                  ? passRate >= (run.passCriteria?.minimumPassRate ?? 100)
                    ? "passed"
                    : "failed"
                  : run.status === "cancelled"
                    ? "cancelled"
                    : "pending");
              const runBorderColor = getIterationBorderColor(runResult);

              const isSelected = selectedRunIds.has(run._id);

              const runButton = (
                <div className="flex items-center gap-6 w-full">
                  <div className="pl-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleRunSelection(run._id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select run ${formatRunId(run._id)}`}
                    />
                  </div>
                  <button
                    onClick={() => onRunClick(run._id)}
                    className="flex flex-1 items-center gap-6 py-2.5 pr-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <span className="text-xs font-medium min-w-[120px]">
                      Run {formatRunId(run._id)}
                    </span>
                    <span className="text-xs text-muted-foreground min-w-[140px]">
                      {timestamp}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono min-w-[60px]">
                      {duration}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground min-w-[60px] text-right">
                      {passed}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground min-w-[60px] text-right">
                      {failed}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground min-w-[70px] text-right">
                      {passRate !== null ? `${passRate}%` : "—"}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground min-w-[70px] text-right">
                      {totalTokens > 0 ? totalTokens.toLocaleString() : "—"}
                    </span>
                  </button>
                </div>
              );

              return (
                <div
                  key={run._id}
                  className={cn(
                    "relative overflow-hidden",
                    isInactive && "opacity-50",
                  )}
                >
                  <div
                    className={`absolute left-0 top-0 h-full w-1 ${runBorderColor}`}
                  />
                  {isInactive ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{runButton}</TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Run is inactive since test cases were updated
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    runButton
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Batch Delete Confirmation Modal */}
      <Dialog
        open={showBatchDeleteModal}
        onOpenChange={setShowBatchDeleteModal}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Delete {selectedRunIds.size} Run
              {selectedRunIds.size !== 1 ? "s" : ""}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedRunIds.size} run
              {selectedRunIds.size !== 1 ? "s" : ""}?
              <br />
              <br />
              This will permanently delete all iterations and results associated
              with {selectedRunIds.size === 1 ? "this run" : "these runs"}. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowBatchDeleteModal(false)}
              disabled={deletingRunId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmBatchDeleteRuns}
              disabled={deletingRunId !== null}
            >
              {deletingRunId ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatTime(timestamp: number | undefined) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return date.toLocaleString();
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
