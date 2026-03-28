import { useMemo } from "react";
import {
  navigateToCiEvalsRoute,
  type CiEvalsRoute,
} from "@/lib/ci-evals-router";
import { SuiteIterationsView } from "./suite-iterations-view";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
} from "./types";

interface HostedCiSuiteWorkspaceDetailProps {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  aggregate: SuiteAggregate | null;
  route: CiEvalsRoute;
  connectedServerNames: Set<string>;
  availableModels: any[];
  onRerun: (suite: EvalSuite) => void;
  onReplayRun?: (suite: EvalSuite, run: EvalSuiteRun) => void;
  onCancelRun: (runId: string) => void;
  onDelete: (suite: EvalSuite) => void;
  onDeleteRun: (runId: string) => void;
  onDirectDeleteRun: (runId: string) => Promise<void>;
  rerunningSuiteId: string | null;
  replayingRunId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  deletingRunId: string | null;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  runDetailSortByOverride?: "model" | "test" | "result";
  onRunDetailSortByChange?: (sort: "model" | "test" | "result") => void;
  omitRunIterationList?: boolean;
  canDeleteRuns?: boolean;
}

export function HostedCiSuiteWorkspaceDetail({
  suite,
  cases,
  iterations,
  allIterations,
  runs,
  runsLoading,
  aggregate,
  route,
  connectedServerNames,
  availableModels,
  onRerun,
  onReplayRun,
  onCancelRun,
  onDelete,
  onDeleteRun,
  onDirectDeleteRun,
  rerunningSuiteId,
  replayingRunId,
  cancellingRunId,
  deletingSuiteId,
  deletingRunId,
  userMap,
  runDetailSortByOverride,
  onRunDetailSortByChange,
  omitRunIterationList = false,
  canDeleteRuns = true,
}: HostedCiSuiteWorkspaceDetailProps) {
  const navigation = useMemo(
    () => ({
      toSuiteOverview: (suiteId: string, view?: "runs" | "test-cases") =>
        navigateToCiEvalsRoute({
          type: "suite-overview",
          suiteId,
          view,
        }),
      toRunDetail: (suiteId: string, runId: string, iteration?: string) =>
        navigateToCiEvalsRoute({
          type: "run-detail",
          suiteId,
          runId,
          iteration,
        }),
      toTestDetail: (suiteId: string, testId: string, iteration?: string) =>
        navigateToCiEvalsRoute({
          type: "test-detail",
          suiteId,
          testId,
          iteration,
        }),
      toTestEdit: (suiteId: string, testId: string) =>
        navigateToCiEvalsRoute({ type: "test-edit", suiteId, testId }),
      toSuiteEdit: (suiteId: string) =>
        navigateToCiEvalsRoute({ type: "suite-edit", suiteId }),
    }),
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6 pt-6">
        <SuiteIterationsView
          suite={suite}
          cases={cases}
          iterations={iterations}
          allIterations={allIterations}
          runs={runs}
          runsLoading={runsLoading}
          aggregate={aggregate}
          caseListInSidebar
          runDetailSortByOverride={runDetailSortByOverride}
          onRunDetailSortByChange={onRunDetailSortByChange}
          omitRunIterationList={omitRunIterationList}
          onRerun={onRerun}
          onReplayRun={onReplayRun}
          onCancelRun={onCancelRun}
          onDelete={onDelete}
          onDeleteRun={onDeleteRun}
          onDirectDeleteRun={onDirectDeleteRun}
          connectedServerNames={connectedServerNames}
          rerunningSuiteId={rerunningSuiteId}
          replayingRunId={replayingRunId}
          cancellingRunId={cancellingRunId}
          deletingSuiteId={deletingSuiteId}
          deletingRunId={deletingRunId}
          availableModels={availableModels}
          route={route}
          userMap={userMap}
          navigation={navigation}
          canDeleteRuns={canDeleteRuns}
        />
      </div>
    </div>
  );
}
