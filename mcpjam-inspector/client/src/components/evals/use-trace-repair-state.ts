import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { startTraceRepair, stopTraceRepair } from "@/lib/apis/evals-api";
import { pickTraceRepairSourceRun } from "@/lib/evals/pick-trace-repair-source-run";
import type {
  AutoFixJobViewSnapshot,
  AutoFixOutcomeSnapshot,
} from "./auto-fix-status-sentence";
import type { EvalSuite, EvalSuiteRun } from "./types";

export type TraceRepairRunHighlight = {
  jobId: string;
  sourceRunId: string;
  latestReplayRunId?: string;
};

export type UseTraceRepairStateRunDetailArgs = {
  mode: "run-detail";
  suiteId: string;
  sourceRunId: string;
  source: EvalSuiteRun["source"] | undefined;
  runStatus: EvalSuiteRun["status"];
  failedIterationCount: number;
  hasServerReplayConfig: boolean | undefined;
};

export type UseTraceRepairStateSuiteOverviewArgs = {
  mode: "suite-overview";
  suite: EvalSuite;
  runs: EvalSuiteRun[];
};

export function useTraceRepairState(
  args: UseTraceRepairStateRunDetailArgs | UseTraceRepairStateSuiteOverviewArgs,
) {
  const suiteId = args.mode === "run-detail" ? args.suiteId : args.suite._id;
  const skipQueries =
    args.mode === "run-detail"
      ? args.source === "sdk"
      : args.suite.source === "sdk";

  const traceRepairJobView = useQuery(
    "traceRepair:getTraceRepairJobView" as any,
    skipQueries ? "skip" : { testSuiteId: suiteId },
  );

  const latestTraceRepairOutcome = useQuery(
    "traceRepair:getLatestTraceRepairOutcome" as any,
    skipQueries ? "skip" : { testSuiteId: suiteId },
  );

  const overviewSuite = args.mode === "suite-overview" ? args.suite : undefined;
  const overviewRuns = args.mode === "suite-overview" ? args.runs : undefined;

  const traceRepairSourceRun = useMemo(() => {
    if (!overviewSuite || !overviewRuns) {
      return null;
    }
    return pickTraceRepairSourceRun(overviewSuite, overviewRuns);
  }, [overviewSuite, overviewRuns]);

  const traceRepairSuiteJobActive =
    traceRepairJobView != null &&
    typeof traceRepairJobView === "object" &&
    traceRepairJobView.scope === "suite" &&
    ["queued", "running", "stopping"].includes(traceRepairJobView.status);

  const [traceRepairStarting, setTraceRepairStarting] = useState(false);

  const handleStart = useCallback(async () => {
    if (args.mode === "run-detail") {
      setTraceRepairStarting(true);
      try {
        await startTraceRepair({
          scope: "suite",
          suiteId: args.suiteId,
          sourceRunId: args.sourceRunId,
        });
      } finally {
        setTraceRepairStarting(false);
      }
      return;
    }
    if (
      !traceRepairSourceRun ||
      traceRepairSourceRun.hasServerReplayConfig !== true
    ) {
      return;
    }
    setTraceRepairStarting(true);
    try {
      await startTraceRepair({
        scope: "suite",
        suiteId: args.suite._id,
        sourceRunId: traceRepairSourceRun._id,
      });
    } finally {
      setTraceRepairStarting(false);
    }
  }, [args, traceRepairSourceRun]);

  const handleStop = useCallback(async () => {
    if (
      !traceRepairJobView ||
      typeof traceRepairJobView !== "object" ||
      !traceRepairJobView.jobId
    ) {
      return;
    }
    await stopTraceRepair(traceRepairJobView.jobId as string);
  }, [traceRepairJobView]);

  const traceRepairActiveBannerView: AutoFixJobViewSnapshot | null =
    traceRepairSuiteJobActive &&
    traceRepairJobView &&
    typeof traceRepairJobView === "object"
      ? {
          jobId: String(traceRepairJobView.jobId),
          status: String(traceRepairJobView.status),
          phase: String(traceRepairJobView.phase),
          scope: "suite" as const,
          currentCaseKey: traceRepairJobView.currentCaseKey ?? undefined,
          activeCaseKeys: traceRepairJobView.activeCaseKeys ?? [],
          attemptLimit: traceRepairJobView.attemptLimit,
          provisionalAppliedCount: traceRepairJobView.provisionalAppliedCount,
          durableFixCount: traceRepairJobView.durableFixCount,
          regressedCount: traceRepairJobView.regressedCount,
          serverLikelyCount: traceRepairJobView.serverLikelyCount,
          exhaustedCount: traceRepairJobView.exhaustedCount,
          promisingCount: traceRepairJobView.promisingCount,
          accuracyBefore: traceRepairJobView.accuracyBefore ?? null,
          accuracyAfter: traceRepairJobView.accuracyAfter ?? null,
        }
      : null;

  const latestTraceRepairOutcomeBanner: AutoFixOutcomeSnapshot | null =
    latestTraceRepairOutcome && typeof latestTraceRepairOutcome === "object"
      ? {
          ...latestTraceRepairOutcome,
          jobId: String(latestTraceRepairOutcome.jobId),
          status: String(latestTraceRepairOutcome.status),
          phase: String(latestTraceRepairOutcome.phase),
          scope:
            latestTraceRepairOutcome.scope === "case"
              ? ("case" as const)
              : ("suite" as const),
          stopReason: latestTraceRepairOutcome.stopReason,
          lastError: latestTraceRepairOutcome.lastError,
          completedAt: latestTraceRepairOutcome.completedAt,
          updatedAt: latestTraceRepairOutcome.updatedAt,
        }
      : null;

  const traceRepairEligible =
    skipQueries === false &&
    (args.mode === "run-detail"
      ? args.runStatus === "completed" &&
        args.failedIterationCount > 0 &&
        args.hasServerReplayConfig === true &&
        !traceRepairSuiteJobActive
      : traceRepairSourceRun != null &&
        traceRepairSourceRun.hasServerReplayConfig === true &&
        !traceRepairSuiteJobActive);

  const traceRepairRunHighlight: TraceRepairRunHighlight | null =
    useMemo(() => {
      if (
        args.mode !== "suite-overview" ||
        !traceRepairSuiteJobActive ||
        !traceRepairJobView ||
        typeof traceRepairJobView !== "object"
      ) {
        return null;
      }
      return {
        jobId: String(traceRepairJobView.jobId),
        sourceRunId: String(traceRepairJobView.sourceRunId),
        latestReplayRunId: traceRepairJobView.latestReplayRunId
          ? String(traceRepairJobView.latestReplayRunId)
          : undefined,
      };
    }, [args.mode, traceRepairSuiteJobActive, traceRepairJobView]);

  return {
    traceRepairEligible,
    traceRepairStarting,
    traceRepairSuiteJobActive,
    traceRepairActiveBannerView,
    latestTraceRepairOutcomeBanner,
    traceRepairRunHighlight,
    handleStartTraceRepair: handleStart,
    handleStopTraceRepair: handleStop,
  };
}
