import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BarChart3, Loader2, RotateCw, Trash2, X } from "lucide-react";
import { formatRunId } from "./helpers";
import { EvalSuite, EvalSuiteRun } from "./types";
import { useMutation } from "convex/react";
import { toast } from "sonner";

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
}: SuiteHeaderProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(suite.name);
  const updateSuite = useMutation("testSuites:updateTestSuite" as any);

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
      <div className="flex items-center justify-between gap-4 mb-4">
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
