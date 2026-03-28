import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn, getInitials } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { evalStatusLeftBorderClasses, formatRunId } from "./helpers";
import { computeIterationResult } from "./pass-criteria";
import { EvalIteration, EvalSuiteRun } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { SuiteRunsChartGrid } from "./suite-runs-chart-grid";
import { SuiteInsightsCollapsible } from "./suite-insights-collapsible";
import { toast } from "sonner";

interface RunOverviewProps {
  suite: { _id: string; name: string; source?: "ui" | "sdk" };
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
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  /** When false, hides run selection and batch delete (workspace members without admin). */
  canDeleteRuns?: boolean;
}

type CiMetadataCompactMode = "full" | "chip";

type RunsTableLayout = {
  showTokens: boolean;
  showRunBy: boolean;
  metadataMode: CiMetadataCompactMode;
  enableHorizontalScroll: boolean;
  requiredTableWidthPx: number;
};

type RunsTableWidthInput = {
  hasTokenData: boolean;
  hasCiMetadata: boolean;
  showTokens: boolean;
  showRunBy: boolean;
  metadataMode: CiMetadataCompactMode;
  /** When false, width excludes the leading checkbox column. Default true. */
  includeSelectionColumn?: boolean;
};

const TABLE_SELECTION_COL_PX = 28;
const TABLE_GAP_X_PX = 12;
const TABLE_HORIZONTAL_PADDING_PX = 32;
const DEFAULT_TABLE_VIEWPORT_WIDTH_PX = 1200;

const BASE_COL_WIDTHS_PX = {
  runId: 110,
  startTime: 180,
  duration: 72,
  passed: 56,
  failed: 56,
  total: 56,
  passRate: 72,
  tokens: 88,
  runBy: 56,
  metadataFull: 140,
  metadataChip: 72,
} as const;

function getTableColumnCount(input: RunsTableWidthInput): number {
  let count = input.includeSelectionColumn === false ? 0 : 1; // selection checkbox column
  count += 7; // required run columns
  if (input.hasTokenData && input.showTokens) {
    count += 1;
  }
  if (input.showRunBy) {
    count += 1;
  }
  if (input.hasCiMetadata) {
    count += 1;
  }
  return count;
}

export function estimateRunsTableRequiredWidth(
  input: RunsTableWidthInput,
): number {
  let width =
    (input.includeSelectionColumn === false ? 0 : TABLE_SELECTION_COL_PX) +
    BASE_COL_WIDTHS_PX.runId +
    BASE_COL_WIDTHS_PX.startTime +
    BASE_COL_WIDTHS_PX.duration +
    BASE_COL_WIDTHS_PX.passed +
    BASE_COL_WIDTHS_PX.failed +
    BASE_COL_WIDTHS_PX.total +
    BASE_COL_WIDTHS_PX.passRate;

  if (input.hasTokenData && input.showTokens) {
    width += BASE_COL_WIDTHS_PX.tokens;
  }
  if (input.showRunBy) {
    width += BASE_COL_WIDTHS_PX.runBy;
  }
  if (input.hasCiMetadata) {
    width +=
      input.metadataMode === "chip"
        ? BASE_COL_WIDTHS_PX.metadataChip
        : BASE_COL_WIDTHS_PX.metadataFull;
  }

  const columnCount = getTableColumnCount(input);
  const totalGaps = Math.max(0, columnCount - 1) * TABLE_GAP_X_PX;
  return width + totalGaps + TABLE_HORIZONTAL_PADDING_PX;
}

export function resolveRunsTableLayout(input: {
  containerWidth: number;
  hasTokenData: boolean;
  hasCiMetadata: boolean;
  includeSelectionColumn?: boolean;
}): RunsTableLayout {
  const normalizedContainerWidth = Math.max(
    0,
    Math.floor(input.containerWidth),
  );
  const showTokens = input.hasTokenData;
  const showRunBy = true;
  const metadataMode: CiMetadataCompactMode = "full";
  const requiredTableWidthPx = estimateRunsTableRequiredWidth({
    hasTokenData: input.hasTokenData,
    hasCiMetadata: input.hasCiMetadata,
    showTokens,
    showRunBy,
    metadataMode,
    includeSelectionColumn: input.includeSelectionColumn,
  });
  const enableHorizontalScroll =
    requiredTableWidthPx > normalizedContainerWidth;

  return {
    showTokens,
    showRunBy,
    metadataMode,
    enableHorizontalScroll,
    requiredTableWidthPx,
  };
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
  userMap,
  canDeleteRuns = true,
}: RunOverviewProps) {
  const tableViewportRef = useRef<HTMLDivElement | null>(null);
  const [tableViewportWidth, setTableViewportWidth] = useState(0);

  const hasTokenData = useMemo(
    () => allIterations.some((i) => (i.tokensUsed || 0) > 0),
    [allIterations],
  );

  const hasCiMetadata = useMemo(
    () =>
      runs.some(
        (r) =>
          !!r.ciMetadata?.branch ||
          !!r.ciMetadata?.commitSha ||
          !!r.ciMetadata?.runUrl,
      ),
    [runs],
  );

  useEffect(() => {
    const element = tableViewportRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setTableViewportWidth(Math.max(0, Math.floor(element.clientWidth)));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => {
        window.removeEventListener("resize", updateWidth);
      };
    }

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, []);

  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteModal, setShowBatchDeleteModal] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!canDeleteRuns) {
      setSelectedRunIds(new Set());
      setShowBatchDeleteModal(false);
    }
  }, [canDeleteRuns]);

  const responsiveLayout = useMemo(
    () =>
      resolveRunsTableLayout({
        containerWidth:
          tableViewportWidth > 0
            ? tableViewportWidth
            : DEFAULT_TABLE_VIEWPORT_WIDTH_PX,
        hasTokenData,
        hasCiMetadata,
        includeSelectionColumn: canDeleteRuns,
      }),
    [tableViewportWidth, hasTokenData, hasCiMetadata, canDeleteRuns],
  );

  const rowGridTemplateColumns = useMemo(() => {
    const columns = [
      "minmax(110px, 1.1fr)",
      "minmax(180px, 1.7fr)",
      "minmax(72px, 0.7fr)",
      "minmax(56px, 0.55fr)",
      "minmax(56px, 0.55fr)",
      "minmax(56px, 0.55fr)",
      "minmax(72px, 0.65fr)",
    ];

    if (hasTokenData && responsiveLayout.showTokens) {
      columns.push("minmax(88px, 0.8fr)");
    }

    if (responsiveLayout.showRunBy) {
      columns.push("minmax(56px, 0.5fr)");
    }

    if (hasCiMetadata) {
      columns.push(
        responsiveLayout.metadataMode === "chip"
          ? "minmax(72px, 0.7fr)"
          : "minmax(140px, 1.3fr)",
      );
    }

    return columns.join(" ");
  }, [hasTokenData, hasCiMetadata, responsiveLayout]);

  const fullGridTemplateColumns = useMemo(
    () =>
      canDeleteRuns ? `28px ${rowGridTemplateColumns}` : rowGridTemplateColumns,
    [canDeleteRuns, rowGridTemplateColumns],
  );

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      {runs.length > 0 && (
        <SuiteRunsChartGrid
          suiteSource={suite.source}
          runTrendData={runTrendData}
          modelStats={modelStats}
          runsLoading={runsLoading}
          onRunClick={onRunClick}
        />
      )}
      <SuiteInsightsCollapsible runs={runs} />
      {/* Runs List */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border bg-card text-card-foreground">
        {canDeleteRuns && selectedRunIds.size > 0 ? (
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
                Click on a run to view its case breakdown and results.
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
              <option value="test-cases">Cases</option>
            </select>
          </div>
        )}

        <div
          ref={tableViewportRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto"
        >
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            style={
              responsiveLayout.enableHorizontalScroll
                ? { minWidth: `${responsiveLayout.requiredTableWidthPx}px` }
                : undefined
            }
          >
            {/* Column Headers */}
            {runs.length > 0 && (
              <div className="shrink-0 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                <div
                  className="grid items-center gap-x-3"
                  style={{ gridTemplateColumns: fullGridTemplateColumns }}
                >
                  {canDeleteRuns && <div className="h-4 w-4" />}
                  <div>Run ID</div>
                  <div>Start time</div>
                  <div>Duration</div>
                  <div className="text-right">Passed</div>
                  <div className="text-right">Failed</div>
                  <div className="text-right">Total</div>
                  <div className="text-right">
                    {suite.source === "sdk" ? "Pass Rate" : "Accuracy"}
                  </div>
                  {hasTokenData && responsiveLayout.showTokens && (
                    <div className="text-right">Tokens</div>
                  )}
                  {responsiveLayout.showRunBy && <div>Run by</div>}
                  {hasCiMetadata && <div>Metadata</div>}
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 divide-y overflow-y-auto">
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
                    realTimeTotal > 0
                      ? realTimeTotal
                      : (run.summary?.total ?? 0);
                  const passRate =
                    total > 0 ? Math.round((passed / total) * 100) : null;

                  const timestamp = formatTime(
                    run.completedAt ?? run.createdAt,
                  );

                  const duration =
                    run.completedAt && run.createdAt
                      ? formatDuration(run.completedAt - run.createdAt)
                      : run.createdAt && run.status === "running"
                        ? formatDuration(Date.now() - run.createdAt)
                        : "—";

                  const runResult =
                    run.result ||
                    (run.status === "completed" && passRate !== null
                      ? passRate >= (run.passCriteria?.minimumPassRate ?? 100)
                        ? "passed"
                        : "failed"
                      : run.status === "cancelled"
                        ? "cancelled"
                        : run.status === "running"
                          ? "running"
                          : "pending");
                  const runAccent = evalStatusLeftBorderClasses(runResult);

                  const isSelected = selectedRunIds.has(run._id);
                  const showCiMetadata =
                    !!run.ciMetadata?.branch ||
                    !!run.ciMetadata?.commitSha ||
                    !!run.ciMetadata?.runUrl;

                  const runRowCells = (
                    <>
                      <span className="truncate py-0.5 text-xs font-medium">
                        Run {formatRunId(run._id)}
                      </span>
                      <span className="truncate py-0.5 text-xs text-muted-foreground">
                        {timestamp}
                      </span>
                      <span className="py-0.5 text-xs font-mono text-muted-foreground">
                        {duration}
                      </span>
                      <span className="py-0.5 text-right text-xs font-mono text-muted-foreground">
                        {passed}
                      </span>
                      <span className="py-0.5 text-right text-xs font-mono text-muted-foreground">
                        {failed}
                      </span>
                      <span className="py-0.5 text-right text-xs font-mono text-muted-foreground">
                        {total}
                      </span>
                      <span className="py-0.5 text-right text-xs font-mono text-muted-foreground">
                        {passRate !== null ? `${passRate}%` : "—"}
                      </span>
                      {hasTokenData && responsiveLayout.showTokens && (
                        <span className="py-0.5 text-right text-xs font-mono text-muted-foreground">
                          {totalTokens > 0 ? totalTokens.toLocaleString() : "—"}
                        </span>
                      )}
                      {responsiveLayout.showRunBy && (
                        <span className="py-0.5">
                          {(() => {
                            const creator =
                              run.createdBy && userMap?.get(run.createdBy);
                            if (creator) {
                              return (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Avatar className="size-6">
                                      <AvatarImage
                                        src={creator.imageUrl}
                                        alt={creator.name}
                                      />
                                      <AvatarFallback className="text-[10px]">
                                        {getInitials(creator.name)}
                                      </AvatarFallback>
                                    </Avatar>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="text-xs">{creator.name}</p>
                                  </TooltipContent>
                                </Tooltip>
                              );
                            }
                            return (
                              <Avatar className="size-6">
                                <AvatarFallback className="text-[10px]">
                                  ?
                                </AvatarFallback>
                              </Avatar>
                            );
                          })()}
                        </span>
                      )}
                      {hasCiMetadata && (
                        <span className="min-w-0 py-0.5">
                          {showCiMetadata ? (
                            <CiMetadataDisplay
                              ciMetadata={run.ciMetadata}
                              compact={true}
                              compactMode={responsiveLayout.metadataMode}
                              interactive={false}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </span>
                      )}
                    </>
                  );

                  const runButton = canDeleteRuns ? (
                    <div
                      className="grid items-center gap-x-3 px-4 py-2.5"
                      style={{ gridTemplateColumns: fullGridTemplateColumns }}
                    >
                      <div className="flex justify-center">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRunSelection(run._id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select run ${formatRunId(run._id)}`}
                        />
                      </div>
                      <button
                        onClick={() => onRunClick(run._id)}
                        className="col-[2/-1] grid w-full items-center gap-x-3 rounded-sm text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                        style={{ gridTemplateColumns: rowGridTemplateColumns }}
                      >
                        {runRowCells}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => onRunClick(run._id)}
                      className="grid w-full items-center gap-x-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      style={{ gridTemplateColumns: rowGridTemplateColumns }}
                    >
                      {runRowCells}
                    </button>
                  );

                  return (
                    <div
                      key={run._id}
                      className={cn("relative border-l-2", runAccent)}
                    >
                      {runButton}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Batch Delete Confirmation Modal */}
      <Dialog
        open={canDeleteRuns && showBatchDeleteModal}
        onOpenChange={(open) => {
          if (canDeleteRuns) setShowBatchDeleteModal(open);
        }}
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
    </div>
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
