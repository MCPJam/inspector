import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import posthog from "posthog-js";
import { Loader2, Play, Plus, Puzzle, Sparkles, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  EVAL_DESTRUCTIVE_BUTTON_CLASS,
  EVAL_FAILED_BADGE_CLASS,
  EVAL_LOW_PASS_RATE_TEXT_CLASS,
} from "./constants";
import { ITERATION_RESULT_BADGE_BASE } from "./iteration-result-presentation";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { computeIterationResult } from "./pass-criteria";
import { formatRelativeTime, getEffectiveSuiteServers } from "./helpers";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";
import { isPinnedOnly } from "@/shared/prompt-turns";
import type { SuiteOverviewView } from "@/lib/eval-route-types";
import {
  caseListCardClassName,
  CaseListColumnHeaders,
} from "./case-list-shared";
import { CrossHostDashboard } from "./cross-host/cross-host-dashboard";

function iterationRecencyTs(iter: EvalIteration): number {
  return iter.updatedAt ?? iter.startedAt ?? iter.createdAt ?? 0;
}

interface TestCasesOverviewProps {
  suite: {
    _id: string;
    name: string;
    environment?: { servers?: string[] };
    /** Host attachments drive the "By host" matrix; absent on minimal callers. */
    hostAttachments?: EvalSuite["hostAttachments"];
  };
  cases: EvalCase[];
  allIterations: EvalIteration[];
  /**
   * Suite runs, required to build the cross-host matrix. Optional because
   * minimal callers don't need it; the matrix only renders when host
   * attachments exist, which implies runs.
   */
  runs?: EvalSuiteRun[];
  runsViewMode: SuiteOverviewView;
  onViewModeChange: (value: SuiteOverviewView) => void;
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
  runTestCaseDisabledReason?: string | null;
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
  /** When true, the surrounding view is the direct-guest eval playground. */
  isDirectGuest?: boolean;
  /**
   * Empty-state CTAs (Playground). When provided, the "No test cases yet" empty
   * state shows Generate / New case buttons above the message — the same actions
   * as the suite header, surfaced where the user is looking.
   */
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  /** Why Generate is disabled (shown in its tooltip), mirroring the suite header. */
  generateTestCasesDisabledReason?: string;
  isGeneratingTestCases?: boolean;
  onCreateTestCase?: () => void;
}

export function TestCasesOverview({
  suite,
  cases,
  runs,
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
  runTestCaseDisabledReason = null,
  connectedServerNames,
  isDirectGuest = false,
  onGenerateTestCases,
  canGenerateTestCases = false,
  generateTestCasesDisabledReason,
  isGeneratingTestCases = false,
  onCreateTestCase,
}: TestCasesOverviewProps) {
  const convex = useConvex();
  // A one-host matrix is pointless, so the cross-host view is only offered when
  // the suite has >=2 host attachments. Same source useCrossHostData reads.
  const hostAttachmentCount = suite.hostAttachments?.length ?? 0;
  const canShowByHost = hostAttachmentCount >= 2;
  const isByHostView = canShowByHost && runsViewMode === "runs";
  const liveCases = useQuery(
    "testSuites:listTestCases" as any,
    { suiteId: suite._id } as any
  ) as EvalCase[] | undefined;
  const [hydratedIterations, setHydratedIterations] = useState<EvalIteration[]>(
    []
  );
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(
    new Set()
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
      liveCases.map((testCase) => [testCase._id, testCase] as const)
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
        `Deleted ${ids.length} test case${ids.length === 1 ? "" : "s"}`
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
      allIterations.map((iteration) => iteration._id)
    );
    const localCaseIds = new Set(
      allIterations
        .map((iteration) => iteration.testCaseId)
        .filter(
          (testCaseId): testCaseId is string => typeof testCaseId === "string"
        )
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
              { testCaseId: testCase._id } as any
            )) as EvalIteration[] | undefined;

            if (Array.isArray(iterations) && iterations.length > 0) {
              return iterations;
            }
          } catch (error) {
            console.error(
              "Failed to hydrate test case iterations from listTestIterations:",
              error
            );
          }

          if (!testCase.lastMessageRun) {
            return [];
          }

          try {
            const iteration = (await convex.query(
              "testSuites:getTestIteration" as any,
              { iterationId: testCase.lastMessageRun } as any
            )) as EvalIteration | null;
            return iteration ? [iteration] : [];
          } catch (error) {
            console.error(
              "Failed to hydrate saved iteration from getTestIteration:",
              error
            );
            return [];
          }
        })
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
        (iter) => iter.testCaseId === testCase._id
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
  // Effective list = legacy `environment.servers` merged with any host
  // attachments' `resolvedServerNames`. Without the merge, per-case Run
  // buttons stay disabled on attachment-only suites (the current model).
  const suiteServers = getEffectiveSuiteServers(suite);
  const missingSuiteServers =
    connectedServerNames == null
      ? []
      : suiteServers.filter(
          (serverName) => !connectedServerNames.has(serverName)
        );
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
      <div
        className={cn(
          // Empty state floats with no card border/background; the bordered
          // card only frames an actual list of cases.
          testCaseStats.length === 0 ? "flex flex-col" : caseListCardClassName,
          isByHostView ? "min-h-[min(70vh,720px)] flex-1" : "max-h-[600px]"
        )}
      >
        {!isByHostView &&
        batchDelete &&
        (showPersistentBatchHeader || selectedCaseIds.size > 0) ? (
          <div className="border-b px-4 py-2 shrink-0 bg-muted/50 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              {!isByHostView ? (
                <Checkbox
                  checked={selectedCaseIds.size === testCaseStats.length}
                  onCheckedChange={toggleAllCases}
                  aria-label="Select all cases"
                  disabled={testCaseStats.length === 0}
                />
              ) : null}
              <span className="text-xs font-medium truncate">Test Cases</span>
            </div>
            {selectedCaseIds.size > 0 ? (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {selectedCaseIds.size} selected
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  onClick={() => setSelectedCaseIds(new Set())}
                  disabled={isBatchDeleting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className={cn("h-8", EVAL_DESTRUCTIVE_BUTTON_CLASS)}
                  onClick={() => setShowBatchDeleteModal(true)}
                  disabled={isBatchDeleting}
                >
                  Delete
                </Button>
              </div>
            ) : null}
          </div>
        ) : !showDisconnectedPlaygroundEmptyState &&
          !(
            !isByHostView &&
            hideViewModeSelect &&
            testCaseStats.length === 0
          ) ? (
          <div
            className={cn(
              "shrink-0 flex items-center justify-between gap-3 border-b",
              isByHostView ? "bg-muted/60 px-4 py-2.5" : "px-4 py-2"
            )}
          >
            <div className="min-w-0">
              {isByHostView ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h2 className="truncate text-base font-semibold leading-tight text-foreground sm:text-lg">
                    Test cases
                    <span className="ml-1.5 font-mono text-sm font-normal tabular-nums text-muted-foreground">
                      · {effectiveCases.length}
                    </span>
                  </h2>
                  <p className="text-[11px] text-muted-foreground">
                    Pass rate, latency, and tokens per attached host
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{clickHint}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!hideViewModeSelect ? (
                <div className="flex items-center rounded-md border bg-muted/40 p-0.5 gap-0.5">
                  {(
                    [
                      { value: "runs", label: "Runs" },
                      { value: "test-cases", label: "Cases" },
                    ] as { value: SuiteOverviewView; label: string }[]
                  ).map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => onViewModeChange(value)}
                      className={cn(
                        "px-2 py-0.5 text-xs rounded transition-colors",
                        runsViewMode === value
                          ? "bg-background text-foreground shadow-sm font-medium"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {isByHostView ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-background">
            <CrossHostDashboard
              suite={suite as EvalSuite}
              cases={effectiveCases}
              runs={runs ?? []}
              allIterations={allIterations}
              expanded
              onTestCaseClick={onTestCaseClick}
            />
          </div>
        ) : (
          <>
            {/* Column Headers */}
            {testCaseStats.length > 0 && (
              <CaseListColumnHeaders
                firstColumnLabel="Case name"
                secondColumnLabel="Last run"
                leadingGutter={batchDelete}
                trailingGutter={showRunColumn}
              />
            )}

            <div className="divide-y overflow-y-auto">
              {testCaseStats.length === 0 ? (
                isGeneratingTestCases ? (
                  <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-4 py-12 text-sm text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
                    <span>Generating test cases…</span>
                  </div>
                ) : showDisconnectedPlaygroundEmptyState ? (
                  <EmptyState
                    icon={Puzzle}
                    title={`Connect to "${disconnectedPlaygroundServerName}" server to generate tests`}
                    description="Playground can automatically generate test cases once a server is connected."
                    className="h-auto min-h-[240px]"
                  />
                ) : hideViewModeSelect ? (
                  <div className="flex min-h-[200px] flex-col items-center justify-center gap-4 px-4 py-12">
                    {onGenerateTestCases || onCreateTestCase ? (
                      <div className="flex items-center gap-2">
                        {onGenerateTestCases ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <Button
                                  type="button"
                                  variant="default"
                                  className="h-11 gap-2 px-6 text-sm"
                                  onClick={onGenerateTestCases}
                                  disabled={
                                    !canGenerateTestCases ||
                                    isGeneratingTestCases
                                  }
                                  aria-busy={isGeneratingTestCases}
                                >
                                  {isGeneratingTestCases ? (
                                    <Loader2
                                      className="h-4 w-4 shrink-0 animate-spin"
                                      aria-hidden
                                    />
                                  ) : (
                                    <Sparkles
                                      className="h-4 w-4 shrink-0"
                                      aria-hidden
                                    />
                                  )}
                                  Generate
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              variant="muted"
                              side="bottom"
                              sideOffset={6}
                            >
                              {isGeneratingTestCases
                                ? "Generating test cases…"
                                : !canGenerateTestCases
                                ? generateTestCasesDisabledReason ??
                                  "Configure suite servers before generating cases."
                                : "Generate suggested cases from your server's tools."}
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                        {onCreateTestCase ? (
                          <Button
                            type="button"
                            variant="default"
                            className="h-11 gap-2 px-6 text-sm"
                            onClick={onCreateTestCase}
                          >
                            <Plus
                              className="h-4 w-4 shrink-0"
                              aria-hidden
                            />
                            New case
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
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
                          (serverName) => !connectedServerNames.has(serverName)
                        );
                  const hasModels = Boolean(testCase.models?.length);
                  // Render checks have no quick-run path (suite/schedule only);
                  // keep the gate explicit rather than riding on their empty
                  // models. Detect both legacy widget_probe and new unified
                  // pinned-only cases.
                  const isProbeCase = isPinnedOnly({
                    caseType: testCase.caseType,
                    promptTurns: testCase.promptTurns,
                  });
                  const isThisCaseRunning = runningTestCaseId === testCase._id;
                  const isAnotherCaseRunning =
                    runningTestCaseId != null &&
                    runningTestCaseId !== testCase._id;
                  // Guests rely on the local persistent MCP manager; skip the
                  // suite-server-connected gate and let the runner surface a
                  // connection error if the server is actually missing.
                  const serverGateBlocked =
                    !isDirectGuest && missingServers.length > 0;
                  const runDisabled =
                    !onRunTestCase ||
                    blockTestCaseRuns ||
                    Boolean(runTestCaseDisabledReason) ||
                    isAnotherCaseRunning ||
                    isProbeCase ||
                    !hasModels ||
                    serverGateBlocked ||
                    isThisCaseRunning;
                  const disconnectedRunTooltip = serverGateBlocked
                    ? "Connect and run."
                    : runTestCaseDisabledReason;

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
                    ? lastRunIteration.updatedAt ??
                      lastRunIteration.startedAt ??
                      lastRunIteration.createdAt ??
                      null
                    : null;
                  const caseTitle = testCase.title || "Untitled test case";
                  const passBadge = (
                    <span
                      className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-success/50 text-foreground"
                      aria-label="Passed"
                    >
                      Passed
                    </span>
                  );
                  const failBadge = (
                    <span
                      className={cn(
                        ITERATION_RESULT_BADGE_BASE,
                        "tracking-wider",
                        EVAL_FAILED_BADGE_CLASS
                      )}
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
                    onOpenLastRun && lastRunIteration?._id
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
                    </div>
                  );

                  const caseAndLast = (
                    <>
                      <span className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-foreground">
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
                      isProbeCase ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{runButton}</TooltipTrigger>
                          <TooltipContent
                            variant="muted"
                            side="left"
                            sideOffset={8}
                            className="max-w-[16rem]"
                          >
                            Render checks run with the full suite or on its
                            schedule.
                          </TooltipContent>
                        </Tooltip>
                      ) : !hasConfiguredSuiteServers ? (
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
                            aria-label={`Select case ${
                              testCase.title || "Untitled test case"
                            }`}
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
          </>
        )}
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
              <Trash2
                className={cn("h-5 w-5", EVAL_LOW_PASS_RATE_TEXT_CLASS)}
              />
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
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
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
