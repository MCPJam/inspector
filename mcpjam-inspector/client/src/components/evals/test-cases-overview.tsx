import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import posthog from "posthog-js";
import { CircleAlert, Loader2, Play, Puzzle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { computeIterationResult } from "./pass-criteria";
import { formatRelativeTime } from "./helpers";
import type { EvalCase, EvalIteration } from "./types";

function iterationRecencyTs(iter: EvalIteration): number {
  return iter.updatedAt ?? iter.startedAt ?? iter.createdAt ?? 0;
}

interface TestCasesOverviewProps {
  suite: {
    _id: string;
    name: string;
    environment?: { servers?: string[] };
  };
  cases: EvalCase[];
  allIterations: EvalIteration[];
  runsViewMode: "runs" | "test-cases";
  onViewModeChange: (value: "runs" | "test-cases") => void;
  onTestCaseClick: (testCaseId: string) => void;
  clickHint?: string;
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
  /** When set, each row shows a Run control (e.g. Explore / CI suite overview). */
  onRunTestCase?: (testCase: EvalCase) => void;
  runningTestCaseId?: string | null;
  /** True while a suite rerun or run replay is in progress (disables per-case Run). */
  blockTestCaseRuns?: boolean;
  /** Required for server connection gating when set; when omitted, server gating is skipped. */
  connectedServerNames?: Set<string>;
  /** Playground / contexts where switching to the runs table is not offered. */
  hideViewModeSelect?: boolean;
  /**
   * When set, the Last run summary opens test detail focused on that iteration (one click).
   */
  onOpenLastRun?: (testCaseId: string, iterationId: string) => void;
  /**
   * When set (e.g. playground), show run-style selection + batch delete for test cases.
   */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
}

export function TestCasesOverview({
  suite,
  cases,
  allIterations,
  runsViewMode,
  onViewModeChange,
  onTestCaseClick,
  clickHint = "Click on a case to view its run history and performance.",
  hideViewModeSelect = false,
  onOpenLastRun,
  onDeleteTestCasesBatch,
  onRunTestCase,
  runningTestCaseId = null,
  blockTestCaseRuns = false,
  connectedServerNames,
}: TestCasesOverviewProps) {
  const convex = useConvex();
  const liveCases = useQuery(
    "testSuites:listTestCases" as any,
    { suiteId: suite._id } as any,
  ) as EvalCase[] | undefined;
  const [hydratedIterations, setHydratedIterations] = useState<EvalIteration[]>(
    [],
  );
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(
    new Set(),
  );
  const [showBatchDeleteModal, setShowBatchDeleteModal] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);

  useEffect(() => {
    if (!onDeleteTestCasesBatch) {
      setSelectedCaseIds(new Set());
      setShowBatchDeleteModal(false);
    }
  }, [onDeleteTestCasesBatch]);

  const toggleCaseSelection = useCallback((testCaseId: string) => {
    setSelectedCaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(testCaseId)) {
        next.delete(testCaseId);
      } else {
        next.add(testCaseId);
      }
      return next;
    });
  }, []);

  const effectiveCases = useMemo(() => {
    if (!liveCases) {
      return cases;
    }

    const liveCaseById = new Map(
      liveCases.map((testCase) => [testCase._id, testCase] as const),
    );
    const mergedCases = cases.map((testCase) => ({
      ...testCase,
      ...(liveCaseById.get(testCase._id) ?? {}),
    }));

    for (const liveCase of liveCases) {
      if (!cases.some((testCase) => testCase._id === liveCase._id)) {
        mergedCases.push(liveCase);
      }
    }

    return mergedCases;
  }, [cases, liveCases]);

  const toggleAllCases = useCallback(() => {
    setSelectedCaseIds((prev) => {
      if (prev.size === effectiveCases.length) {
        return new Set();
      }
      return new Set(effectiveCases.map((c) => c._id));
    });
  }, [effectiveCases]);

  const confirmBatchDeleteTestCases = useCallback(async () => {
    if (!onDeleteTestCasesBatch) return;
    const ids = Array.from(selectedCaseIds);
    if (ids.length === 0) return;

    setIsBatchDeleting(true);
    try {
      await onDeleteTestCasesBatch(ids);
      setSelectedCaseIds(new Set());
      setShowBatchDeleteModal(false);
      toast.success(
        `Deleted ${ids.length} test case${ids.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      console.error("Failed to delete test cases:", error);
      toast.error(getBillingErrorMessage(error, "Failed to delete test cases"));
    } finally {
      setIsBatchDeleting(false);
    }
  }, [onDeleteTestCasesBatch, selectedCaseIds]);

  useEffect(() => {
    const localIterationIds = new Set(
      allIterations.map((iteration) => iteration._id),
    );
    const localCaseIds = new Set(
      allIterations
        .map((iteration) => iteration.testCaseId)
        .filter(
          (testCaseId): testCaseId is string => typeof testCaseId === "string",
        ),
    );
    const casesNeedingHydration = effectiveCases.filter((testCase) => {
      const missingSavedIteration =
        typeof testCase.lastMessageRun === "string" &&
        !localIterationIds.has(testCase.lastMessageRun);
      const hasLocalIterations = localCaseIds.has(testCase._id);
      return missingSavedIteration || !hasLocalIterations;
    });

    if (casesNeedingHydration.length === 0) {
      setHydratedIterations((current) => (current.length === 0 ? current : []));
      return;
    }

    let cancelled = false;

    void (async () => {
      const fetched = await Promise.all(
        casesNeedingHydration.map(async (testCase) => {
          try {
            const iterations = (await convex.query(
              "testSuites:listTestIterations" as any,
              { testCaseId: testCase._id } as any,
            )) as EvalIteration[] | undefined;

            if (Array.isArray(iterations) && iterations.length > 0) {
              return iterations;
            }
          } catch (error) {
            console.error(
              "Failed to hydrate test case iterations from listTestIterations:",
              error,
            );
          }

          if (!testCase.lastMessageRun) {
            return [];
          }

          try {
            const iteration = (await convex.query(
              "testSuites:getTestIteration" as any,
              { iterationId: testCase.lastMessageRun } as any,
            )) as EvalIteration | null;
            return iteration ? [iteration] : [];
          } catch (error) {
            console.error(
              "Failed to hydrate saved iteration from getTestIteration:",
              error,
            );
            return [];
          }
        }),
      );

      if (cancelled) {
        return;
      }

      const deduped = new Map<string, EvalIteration>();
      for (const iteration of [...allIterations, ...fetched.flat()]) {
        if (iteration?._id) {
          deduped.set(iteration._id, iteration);
        }
      }
      setHydratedIterations(Array.from(deduped.values()));
    })();

    return () => {
      cancelled = true;
    };
  }, [allIterations, convex, effectiveCases]);

  const effectiveIterations = useMemo(() => {
    const deduped = new Map<string, EvalIteration>();
    for (const iteration of [...allIterations, ...hydratedIterations]) {
      if (iteration?._id) {
        deduped.set(iteration._id, iteration);
      }
    }
    return Array.from(deduped.values());
  }, [allIterations, hydratedIterations]);

  // Per-case latest iteration by wall time (for “Last run”)
  const testCaseStats = useMemo(() => {
    return effectiveCases.map((testCase) => {
      const caseIterations = effectiveIterations.filter(
        (iter) => iter.testCaseId === testCase._id,
      );
      let lastRunIteration: EvalIteration | null = null;
      for (const iter of caseIterations) {
        if (
          !lastRunIteration ||
          iterationRecencyTs(iter) >= iterationRecencyTs(lastRunIteration)
        ) {
          lastRunIteration = iter;
        }
      }
      return {
        testCase,
        lastRunIteration,
      };
    });
  }, [effectiveCases, effectiveIterations]);

  const batchDelete = Boolean(onDeleteTestCasesBatch);
  const showRunColumn = Boolean(onRunTestCase);
  const suiteServers = suite.environment?.servers ?? [];
  const missingSuiteServers =
    connectedServerNames == null
      ? []
      : suiteServers.filter((serverName) => !connectedServerNames.has(serverName));
  const showPersistentBatchHeader =
    batchDelete && hideViewModeSelect && testCaseStats.length > 0;
  const showDisconnectedPlaygroundEmptyState =
    hideViewModeSelect &&
    testCaseStats.length === 0 &&
    missingSuiteServers.length > 0;
  const disconnectedPlaygroundServerName =
    missingSuiteServers[0] ?? suiteServers[0] ?? "your server";

  return (
    <>
      {/* Cases List */}
      <div className="rounded-xl border bg-card text-card-foreground flex flex-col max-h-[600px]">
        {batchDelete &&
        (showPersistentBatchHeader || selectedCaseIds.size > 0) ? (
          <div className="border-b px-4 py-2 shrink-0 bg-muted/50 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <Checkbox
                checked={selectedCaseIds.size === testCaseStats.length}
                onCheckedChange={toggleAllCases}
                aria-label="Select all cases"
                disabled={testCaseStats.length === 0}
              />
              <span className="text-xs font-medium truncate">Select all</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {selectedCaseIds.size > 0 && (
                <span className="text-xs text-muted-foreground">
                  {selectedCaseIds.size} selected
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedCaseIds(new Set())}
                disabled={isBatchDeleting || selectedCaseIds.size === 0}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowBatchDeleteModal(true)}
                disabled={isBatchDeleting || selectedCaseIds.size === 0}
              >
                Delete
              </Button>
            </div>
          </div>
        ) : !showDisconnectedPlaygroundEmptyState ? (
          <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">{clickHint}</p>
            </div>
            <div className="flex items-center gap-2">
              {!hideViewModeSelect ? (
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
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Column Headers */}
        {testCaseStats.length > 0 && (
          <div className="flex items-center gap-3 w-full px-4 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground">
            {batchDelete ? <div className="w-7 shrink-0" aria-hidden /> : null}
            <div className="flex-1 min-w-[120px]">Case name</div>
            <div className="flex flex-1 min-w-0 justify-end items-center gap-2 max-w-[min(100%,20rem)]">
              <span className="text-right">Last run</span>
              <span className="w-3.5 shrink-0" aria-hidden />
            </div>
            {showRunColumn ? (
              <div className="w-7 shrink-0" aria-hidden />
            ) : null}
          </div>
        )}

        <div className="divide-y overflow-y-auto">
          {testCaseStats.length === 0 ? (
            showDisconnectedPlaygroundEmptyState ? (
              <EmptyState
                icon={Puzzle}
                title={`Start ${disconnectedPlaygroundServerName} to generate tests`}
                description="Playground can automatically generate test cases once a server is connected."
                className="h-auto min-h-[240px]"
              />
            ) : (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No cases found.
              </div>
            )
          ) : (
            testCaseStats.map(({ testCase, lastRunIteration }) => {
              const hasConfiguredSuiteServers = suiteServers.length > 0;
              const missingServers =
                connectedServerNames == null
                  ? []
                  : suiteServers.filter(
                      (serverName) => !connectedServerNames.has(serverName),
                    );
              const hasModels = Boolean(testCase.models?.length);
              const isThisCaseRunning = runningTestCaseId === testCase._id;
              const isAnotherCaseRunning =
                runningTestCaseId != null && runningTestCaseId !== testCase._id;
              const runDisabled =
                !onRunTestCase ||
                blockTestCaseRuns ||
                isAnotherCaseRunning ||
                !hasModels ||
                !hasConfiguredSuiteServers ||
                isThisCaseRunning;
              const disconnectedRunTooltip =
                missingServers.length > 0
                  ? "Connect and run."
                  : null;

              const lastRunResult = lastRunIteration
                ? computeIterationResult(lastRunIteration)
                : null;
              const lastRunLabel =
                lastRunResult === "passed"
                  ? "Passed"
                  : lastRunResult === "failed"
                    ? "Failed"
                    : lastRunResult === "cancelled"
                      ? "Cancelled"
                      : lastRunResult === "pending"
                        ? "Running"
                        : "Never run";
              const lastRunTimestamp = lastRunIteration
                ? (lastRunIteration.updatedAt ??
                  lastRunIteration.startedAt ??
                  lastRunIteration.createdAt ??
                  null)
                : null;
              const showLastRunFailed = lastRunResult === "failed";
              const caseTitle = testCase.title || "Untitled test case";
              const passBadge = (
                <span
                  className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
                  aria-label="Passed"
                >
                  Passed
                </span>
              );
              const failBadge = (
                <span
                  className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-rose-500/15 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300"
                  aria-label="Failed"
                >
                  Failed
                </span>
              );
              const lastRunSummary = lastRunIteration ? (
                <>
                  {lastRunResult === "passed"
                    ? passBadge
                    : lastRunResult === "failed"
                      ? failBadge
                      : lastRunLabel}
                  {lastRunTimestamp ? (
                    <span className="font-normal">
                      {" "}
                      · {formatRelativeTime(lastRunTimestamp)}
                    </span>
                  ) : null}
                </>
              ) : (
                "Never run"
              );
              const lastRunOpenable = Boolean(
                onOpenLastRun && lastRunIteration?._id,
              );
              const lastRunAriaLabel =
                lastRunIteration && lastRunOpenable
                  ? `View last run: ${lastRunLabel}${
                      lastRunTimestamp
                        ? ` · ${formatRelativeTime(lastRunTimestamp)}`
                        : ""
                    }`
                  : undefined;

              const lastPart = (
                <div className="flex flex-1 min-w-0 justify-end items-center gap-2 max-w-[min(100%,20rem)]">
                  {lastRunOpenable ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenLastRun!(testCase._id, lastRunIteration!._id);
                      }}
                      className="text-xs text-muted-foreground text-right tabular-nums rounded-sm hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      aria-label={lastRunAriaLabel}
                    >
                      {lastRunSummary}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground text-right tabular-nums">
                      {lastRunSummary}
                    </span>
                  )}
                  <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                    {showLastRunFailed ? (
                      <CircleAlert
                        className="h-3.5 w-3.5 text-destructive"
                        aria-label="Last run failed"
                      />
                    ) : null}
                  </span>
                </div>
              );

              const caseAndLast = (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-left">
                    {caseTitle}
                  </span>
                  {lastPart}
                </>
              );

              const caseRowClickTarget = (
                <div
                  className="flex flex-1 min-w-0 items-center gap-3 cursor-pointer rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  tabIndex={0}
                  aria-label={`Open test case: ${caseTitle}`}
                  onClick={() => onTestCaseClick(testCase._id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onTestCaseClick(testCase._id);
                    }
                  }}
                >
                  {caseAndLast}
                </div>
              );

              const runButton = (
                <span className="inline-flex shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={runDisabled}
                    aria-label={`Run ${testCase.title || "test case"}`}
                    aria-busy={isThisCaseRunning}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (runDisabled) return;
                      posthog.capture("run_selected_case_button_clicked", {
                        location: "test_cases_overview",
                        platform: detectPlatform(),
                        environment: detectEnvironment(),
                        test_case_id: testCase._id,
                      });
                      onRunTestCase(testCase);
                    }}
                  >
                    {isThisCaseRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </span>
              );

              const runControl =
                showRunColumn && onRunTestCase ? (
                  !hasConfiguredSuiteServers ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{runButton}</TooltipTrigger>
                      <TooltipContent
                        variant="muted"
                        side="left"
                        sideOffset={8}
                        className="max-w-[16rem]"
                      >
                        Configure suite servers before running this case.
                      </TooltipContent>
                    </Tooltip>
                  ) : disconnectedRunTooltip ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{runButton}</TooltipTrigger>
                      <TooltipContent
                        variant="muted"
                        side="left"
                        sideOffset={8}
                        className="max-w-[16rem]"
                      >
                        {disconnectedRunTooltip}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    runButton
                  )
                ) : null;

              if (batchDelete) {
                const isSelected = selectedCaseIds.has(testCase._id);
                return (
                  <div
                    key={testCase._id}
                    data-testid={`test-case-row-${testCase._id}`}
                    className="flex items-center gap-2 w-full px-4 py-2.5 transition-colors hover:bg-muted/50"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      toggleCaseSelection(testCase._id);
                    }}
                  >
                    <div className="flex justify-center w-7 shrink-0">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() =>
                          toggleCaseSelection(testCase._id)
                        }
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select case ${testCase.title || "Untitled test case"}`}
                      />
                    </div>
                    {caseRowClickTarget}
                    {runControl}
                  </div>
                );
              }

              return (
                <div
                  key={testCase._id}
                  data-testid={`test-case-row-${testCase._id}`}
                  className="flex items-center gap-2 w-full px-4 py-2.5 transition-colors hover:bg-muted/50"
                >
                  {caseRowClickTarget}
                  {runControl}
                </div>
              );
            })
          )}
        </div>
      </div>

      <Dialog
        open={batchDelete && showBatchDeleteModal}
        onOpenChange={(open) => {
          if (batchDelete) setShowBatchDeleteModal(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Delete {selectedCaseIds.size} test case
              {selectedCaseIds.size !== 1 ? "s" : ""}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedCaseIds.size} test case
              {selectedCaseIds.size !== 1 ? "s" : ""}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowBatchDeleteModal(false)}
              disabled={isBatchDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmBatchDeleteTestCases()}
              disabled={isBatchDeleting}
            >
              {isBatchDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
