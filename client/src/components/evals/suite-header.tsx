import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { PieChart, Pie, Label } from "recharts";
import { BarChart3, Loader2, Plus, RotateCw, Trash2, X } from "lucide-react";
import { formatRunId } from "./helpers";
import {
  EvalSuite,
  EvalSuiteRun,
  EvalIteration,
  EvalCase,
  SuiteAggregate,
} from "./types";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { computeIterationResult } from "./pass-criteria";
import type { ModelDefinition } from "@/shared/types";
import { isMCPJamProvidedModel } from "@/shared/types";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";

interface ModelInfo {
  model: string;
  provider: string;
  displayName: string;
}

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
  testCases?: EvalCase[];
  availableModels?: ModelDefinition[];
  onUpdateModels?: (models: ModelInfo[]) => Promise<void>;
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
  testCases = [],
  availableModels = [],
  onUpdateModels,
}: SuiteHeaderProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(suite.name);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const updateSuite = useMutation("testSuites:updateTestSuite" as any);

  // Extract unique models from test cases
  const suiteModels = useMemo(() => {
    if (!testCases || testCases.length === 0) {
      return [];
    }

    const modelSet = new Map<string, ModelInfo>();
    testCases.forEach((testCase) => {
      if (testCase.models && Array.isArray(testCase.models)) {
        testCase.models.forEach((modelConfig: any) => {
          const key = `${modelConfig.provider}:${modelConfig.model}`;
          if (!modelSet.has(key)) {
            const modelDef = availableModels.find(
              (m) => m.id === modelConfig.model,
            );
            modelSet.set(key, {
              model: modelConfig.model,
              provider: modelConfig.provider,
              displayName: modelDef?.name || modelConfig.model,
            });
          }
        });
      }
    });

    return Array.from(modelSet.values());
  }, [testCases, availableModels]);

  // Group available models by provider
  const groupedAvailableModels = useMemo(() => {
    const grouped = new Map<string, ModelDefinition[]>();
    availableModels.forEach((model) => {
      const provider = model.provider;
      if (!grouped.has(provider)) {
        grouped.set(provider, []);
      }
      grouped.get(provider)!.push(model);
    });
    return grouped;
  }, [availableModels]);

  const mcpjamProviders = useMemo(() => {
    return Array.from(groupedAvailableModels.entries())
      .filter(([_, models]) => models.some((m) => isMCPJamProvidedModel(m.id)))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [groupedAvailableModels]);

  const userProviders = useMemo(() => {
    return Array.from(groupedAvailableModels.entries())
      .filter(([_, models]) => models.some((m) => !isMCPJamProvidedModel(m.id)))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [groupedAvailableModels]);

  const handleAddModel = useCallback(
    async (selectedModel: ModelDefinition) => {
      if (!onUpdateModels) return;

      // Check if model already exists
      if (suiteModels.some((m) => m.model === selectedModel.id)) {
        setIsModelDropdownOpen(false);
        return;
      }

      const newModel: ModelInfo = {
        model: selectedModel.id,
        provider: selectedModel.provider,
        displayName: selectedModel.name,
      };

      const updated = [...suiteModels, newModel];
      await onUpdateModels(updated);
      setIsModelDropdownOpen(false);
    },
    [suiteModels, onUpdateModels],
  );

  const handleDeleteModel = useCallback(
    async (modelToDelete: string) => {
      if (!onUpdateModels) return;

      const updated = suiteModels.filter((m) => m.model !== modelToDelete);
      await onUpdateModels(updated);
    },
    [suiteModels, onUpdateModels],
  );

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

    // Calculate passed/failed counts using consistent computation
    // Only count completed iterations - exclude pending/cancelled
    const iterationResults = activeIterations.map((iter) =>
      computeIterationResult(iter),
    );
    const passed = iterationResults.filter((r) => r === "passed").length;
    const failed = iterationResults.filter((r) => r === "failed").length;
    const total = passed + failed; // Only count completed iterations for accuracy

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
                  : "Run all tests"}
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
                              className="fill-foreground text-[10px] font-bold"
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
        {/* Models picker - compact dropdown */}
        {onUpdateModels && (
          <DropdownMenu
            open={isModelDropdownOpen}
            onOpenChange={setIsModelDropdownOpen}
          >
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className={`gap-1.5 ${suiteModels.length === 0 ? "text-destructive border-destructive/50" : ""}`}
              >
                Models
                <Badge
                  variant={
                    suiteModels.length === 0 ? "destructive" : "secondary"
                  }
                  className="px-1.5 py-0 text-[10px] min-w-[18px] justify-center"
                >
                  {suiteModels.length}
                </Badge>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              sideOffset={4}
              className="w-[280px]"
            >
              {/* Current models */}
              {suiteModels.length > 0 && (
                <>
                  <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Active Models
                  </div>
                  {suiteModels.map((modelInfo) => (
                    <div
                      key={modelInfo.model}
                      className="flex items-center justify-between px-2 py-1.5 text-sm"
                    >
                      <span className="truncate">{modelInfo.displayName}</span>
                      <button
                        onClick={() => handleDeleteModel(modelInfo.model)}
                        className="ml-2 p-0.5 text-muted-foreground hover:text-destructive rounded"
                        title="Remove model"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="my-1 h-px bg-border" />
                </>
              )}

              {/* Add models - MCPJam Free */}
              {mcpjamProviders.length > 0 && (
                <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  MCPJam Free Models
                </div>
              )}
              {mcpjamProviders.map(([provider, providerModels]) => {
                const mcpjamModels = providerModels.filter((m) =>
                  isMCPJamProvidedModel(m.id),
                );
                const modelCount = mcpjamModels.length;
                return (
                  <DropdownMenuSub key={`free-${provider}`}>
                    <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                      <ProviderLogo provider={provider} />
                      <div className="flex flex-col flex-1">
                        <span className="font-medium capitalize">
                          {provider}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {modelCount} model{modelCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className="min-w-[200px] max-h-[200px] overflow-y-auto"
                      avoidCollisions={true}
                      collisionPadding={8}
                    >
                      {mcpjamModels.map((model) => {
                        const isAdded = suiteModels.some(
                          (m) => m.model === model.id,
                        );
                        return (
                          <DropdownMenuItem
                            key={model.id}
                            onSelect={() => handleAddModel(model)}
                            className="flex items-center gap-3 text-sm cursor-pointer"
                            disabled={isAdded}
                          >
                            <div className="flex flex-col flex-1">
                              <span className="font-medium">{model.name}</span>
                            </div>
                            {isAdded && (
                              <div className="ml-auto w-2 h-2 bg-primary rounded-full" />
                            )}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}

              {/* Divider between sections */}
              {mcpjamProviders.length > 0 && userProviders.length > 0 && (
                <div className="my-1 h-px bg-muted/50" />
              )}

              {/* Add models - User providers */}
              {userProviders.length > 0 && (
                <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Your Providers
                </div>
              )}
              {userProviders.map(([provider, providerModels]) => {
                const userModels = providerModels.filter(
                  (m) => !isMCPJamProvidedModel(m.id),
                );
                const modelCount = userModels.length;
                return (
                  <DropdownMenuSub key={`user-${provider}`}>
                    <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                      <ProviderLogo provider={provider} />
                      <div className="flex flex-col flex-1">
                        <span className="font-medium capitalize">
                          {provider}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {modelCount} model{modelCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className="min-w-[200px] max-h-[200px] overflow-y-auto"
                      avoidCollisions={true}
                      collisionPadding={8}
                    >
                      {userModels.map((model) => {
                        const isAdded = suiteModels.some(
                          (m) => m.model === model.id,
                        );
                        return (
                          <DropdownMenuItem
                            key={model.id}
                            onSelect={() => handleAddModel(model)}
                            className="flex items-center gap-3 text-sm cursor-pointer"
                            disabled={isAdded}
                          >
                            <div className="flex flex-col flex-1">
                              <span className="font-medium">{model.name}</span>
                            </div>
                            {isAdded && (
                              <div className="ml-auto w-2 h-2 bg-primary rounded-full" />
                            )}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Action buttons */}
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
                Run
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {!canRerun
              ? `Connect the following servers: ${missingServers.join(", ")}`
              : "Run all tests"}
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
