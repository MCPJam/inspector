import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
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
import { PieChart, Pie, Label } from "recharts";
import { BarChart3, Loader2, RotateCw, Trash2, X } from "lucide-react";
import { formatRunId } from "./helpers";
import {
  EvalSuite,
  EvalSuiteRun,
  EvalIteration,
  SuiteAggregate,
} from "./types";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { computeIterationPassed } from "./pass-criteria";

interface SuiteHeaderProps {
  suite: EvalSuite;
  viewMode: "overview" | "run-detail" | "test-detail" | "test-edit";
  selectedRunDetails: EvalSuiteRun | null;
  isEditMode: boolean;
  onRerun: (suite: EvalSuite) => void;
  onDelete: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onViewModeChange: (mode: "overview") => void;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  deletingRunId: string | null;
  showRunSummarySidebar: boolean;
  setShowRunSummarySidebar: (show: boolean) => void;
  runsViewMode?: "runs" | "test-cases";
  runs?: EvalSuiteRun[];
  allIterations?: EvalIteration[];
  aggregate?: SuiteAggregate | null;
}

export function SuiteHeader({
  suite,
  viewMode,
  selectedRunDetails,
  isEditMode,
  onRerun,
  onDelete,
  onCancelRun,
  onDeleteRun,
  onViewModeChange,
  connectedServerNames,
  rerunningSuiteId,
  cancellingRunId,
  deletingSuiteId,
  deletingRunId,
  showRunSummarySidebar,
  setShowRunSummarySidebar,
  runsViewMode = "runs",
  runs = [],
  allIterations = [],
  aggregate = null,
}: SuiteHeaderProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(suite.name);
  const updateSuite = useMutation("testSuites:updateTestSuite" as any);

  // Calculate accuracy chart data from active runs
  const accuracyChartData = useMemo(() => {
    if (!runs || !allIterations || runs.length === 0) {
      return null;
    }

    // Filter to active runs only
    const activeRuns = runs.filter((run) => run.isActive !== false);
    if (activeRuns.length === 0) {
      return null;
    }

    // Get all iterations from active runs
    const activeRunIds = new Set(activeRuns.map((run) => run._id));
    const activeIterations = allIterations.filter(
      (iter) => iter.suiteRunId && activeRunIds.has(iter.suiteRunId),
    );

    if (activeIterations.length === 0) {
      return null;
    }

    // Calculate passed/failed counts
    const passed = activeIterations.filter((iter) =>
      computeIterationPassed(iter),
    ).length;
    const failed = activeIterations.filter(
      (iter) => iter.result === "failed",
    ).length;
    const cancelled = activeIterations.filter(
      (iter) => iter.result === "cancelled",
    ).length;
    const pending = activeIterations.filter(
      (iter) => iter.result === "pending",
    ).length;
    const total = passed + failed + cancelled + pending;

    if (total === 0) {
      return null;
    }

    // Build donut chart data
    const donutData = [];
    if (passed > 0) {
      donutData.push({
        name: "passed",
        value: passed,
        fill: "hsl(142.1 76.2% 36.3%)",
      });
    }
    if (failed > 0) {
      donutData.push({
        name: "failed",
        value: failed,
        fill: "hsl(0 84.2% 60.2%)",
      });
    }
    if (pending > 0) {
      donutData.push({
        name: "pending",
        value: pending,
        fill: "hsl(45.4 93.4% 47.5%)",
      });
    }
    if (cancelled > 0) {
      donutData.push({
        name: "cancelled",
        value: cancelled,
        fill: "hsl(240 3.7% 15.9%)",
      });
    }

    return {
      donutData,
      total,
      accuracy: Math.round((passed / total) * 100),
    };
  }, [runs, allIterations]);

  useEffect(() => {
    setEditedName(suite.name);
  }, [suite.name]);

  const handleNameClick = useCallback(() => {
    setIsEditingName(true);
    setEditedName(suite.name);
  }, [suite.name]);

  const handleNameBlur = useCallback(async () => {
    setIsEditingName(false);
    if (editedName && editedName.trim() && editedName !== suite.name) {
      try {
        await updateSuite({
          suiteId: suite._id,
          name: editedName.trim(),
        });
        toast.success("Suite name updated");
      } catch (error) {
        toast.error("Failed to update suite name");
        console.error("Failed to update suite name:", error);
        setEditedName(suite.name);
      }
    } else {
      setEditedName(suite.name);
    }
  }, [editedName, suite.name, suite._id, updateSuite]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleNameBlur();
      } else if (e.key === "Escape") {
        setIsEditingName(false);
        setEditedName(suite.name);
      }
    },
    [handleNameBlur, suite.name],
  );

  // Calculate suite server status
  const suiteServers = suite.environment?.servers || [];
  const missingServers = suiteServers.filter(
    (server) => !connectedServerNames.has(server),
  );
  const canRerun = missingServers.length === 0;
  const isRerunning = rerunningSuiteId === suite._id;
  const isDeleting = deletingSuiteId === suite._id;

  if (isEditMode) {
    return (
      <div className="flex items-center justify-between gap-4 mb-2 px-6 pt-6 max-w-5xl mx-auto w-full">
        {isEditingName ? (
          <input
            type="text"
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            autoFocus
            className="px-4 py-2 text-xl font-bold border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring bg-background"
          />
        ) : (
          <Button
            variant="ghost"
            onClick={handleNameClick}
            className="px-4 py-2 h-auto text-xl font-bold hover:bg-accent/50 -ml-4 rounded-lg"
          >
            {suite.name}
          </Button>
        )}
      </div>
    );
  }

  if (viewMode === "run-detail" && selectedRunDetails) {
    const isCancelling = cancellingRunId === selectedRunDetails._id;
    const isRunInProgress =
      selectedRunDetails.status === "running" ||
      selectedRunDetails.status === "pending";
    const showAsRunning = isRerunning || isRunInProgress;

    return (
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-lg font-semibold">
          Run {formatRunId(selectedRunDetails._id)}
        </h2>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRunSummarySidebar(!showRunSummarySidebar)}
            className="gap-2"
          >
            <BarChart3 className="h-4 w-4" />
            View run summary
          </Button>
          {isRunInProgress ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onCancelRun(selectedRunDetails._id)}
                  disabled={isCancelling}
                  className="gap-2"
                >
                  {isCancelling ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Cancelling...
                    </>
                  ) : (
                    <>
                      <X className="h-4 w-4" />
                      Cancel run
                    </>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Cancel the current evaluation run</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRerun(suite)}
                    disabled={!canRerun || showAsRunning}
                    className="gap-2"
                  >
                    <RotateCw
                      className={`h-4 w-4 ${showAsRunning ? "animate-spin" : ""}`}
                    />
                    {showAsRunning ? "Running..." : "Rerun"}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {!canRerun
                  ? `Connect the following servers: ${missingServers.join(", ")}`
                  : "Rerun evaluation"}
              </TooltipContent>
            </Tooltip>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDeleteRun(selectedRunDetails._id)}
            disabled={deletingRunId === selectedRunDetails._id}
            className="gap-2"
          >
            <Trash2 className="h-4 w-4" />
            {deletingRunId === selectedRunDetails._id
              ? "Deleting..."
              : "Delete"}
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => onViewModeChange("overview")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  if (viewMode === "test-detail" || viewMode === "test-edit") {
    return null;
  }

  // Overview mode
  return (
    <div className="flex items-center justify-between gap-4 mb-4">
      <div className="flex items-center gap-4 flex-1">
        {isEditingName ? (
          <input
            type="text"
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            autoFocus
            className="px-3 py-2 text-lg font-semibold border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : (
          <Button
            variant="ghost"
            onClick={handleNameClick}
            className="px-3 py-2 h-auto text-lg font-semibold hover:bg-accent"
          >
            {suite.name}
          </Button>
        )}
        {/* Accuracy Chart */}
        {accuracyChartData && accuracyChartData.donutData.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Accuracy:
            </span>
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
                  data={accuracyChartData.donutData}
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
                              {accuracyChartData.accuracy}%
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
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRerun(suite)}
                disabled={!canRerun || isRerunning}
                className="gap-2"
              >
                <RotateCw
                  className={`h-4 w-4 ${isRerunning ? "animate-spin" : ""}`}
                />
                Rerun
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {!canRerun
              ? `Connect the following servers: ${missingServers.join(", ")}`
              : "Rerun evaluation"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onDelete(suite)}
              disabled={isDeleting}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete this test suite</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
