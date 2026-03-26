import { useMemo } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  navigateToCiEvalsRoute,
  type CiEvalsRoute,
} from "@/lib/ci-evals-router";
import { SuiteIterationsView } from "./suite-iterations-view";
import { TestCaseListSidebar } from "./TestCaseListSidebar";
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
  onCreateTestCase: () => void;
  onDeleteTestCase: (testCaseId: string, title: string) => void;
  onDuplicateTestCase: (testCaseId: string) => void;
  onGenerateTests: () => void;
  rerunningSuiteId: string | null;
  replayingRunId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  deletingRunId: string | null;
  deletingTestCaseId: string | null;
  duplicatingTestCaseId: string | null;
  isGeneratingTests: boolean;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
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
  onCreateTestCase,
  onDeleteTestCase,
  onDuplicateTestCase,
  onGenerateTests,
  rerunningSuiteId,
  replayingRunId,
  cancellingRunId,
  deletingSuiteId,
  deletingRunId,
  deletingTestCaseId,
  duplicatingTestCaseId,
  isGeneratingTests,
  userMap,
}: HostedCiSuiteWorkspaceDetailProps) {
  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;
  const selectedTestIdForSidebar =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;
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
    <ResizablePanelGroup direction="horizontal" className="flex h-full">
      <ResizablePanel
        defaultSize={26}
        minSize={18}
        maxSize={36}
        className="border-r bg-muted/30 flex flex-col"
      >
        <TestCaseListSidebar
          testCases={cases}
          suiteId={suite._id}
          selectedTestId={selectedTestIdForSidebar}
          isLoading={runsLoading && cases.length === 0}
          onCreateTestCase={onCreateTestCase}
          onDeleteTestCase={onDeleteTestCase}
          onDuplicateTestCase={onDuplicateTestCase}
          onGenerateTests={onGenerateTests}
          deletingTestCaseId={deletingTestCaseId}
          duplicatingTestCaseId={duplicatingTestCaseId}
          isGeneratingTests={isGeneratingTests}
          showingOverview={
            !selectedTestId &&
            !(
              route.type === "suite-overview" && route.view === "test-cases"
            )
          }
          suite={suite}
          onRerun={onRerun}
          rerunningSuiteId={rerunningSuiteId}
          connectedServerNames={connectedServerNames}
          onNavigateToOverview={(suiteId) =>
            navigateToCiEvalsRoute({ type: "suite-overview", suiteId })
          }
          onSelectTestCase={(suiteId, testId) =>
            navigateToCiEvalsRoute({ type: "test-edit", suiteId, testId })
          }
        />
      </ResizablePanel>

      <ResizableHandle withHandle />

      <ResizablePanel
        defaultSize={74}
        className="flex min-h-0 flex-col overflow-hidden"
      >
        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-6">
          <SuiteIterationsView
            suite={suite}
            cases={cases}
            iterations={iterations}
            allIterations={allIterations}
            runs={runs}
            runsLoading={runsLoading}
            aggregate={aggregate}
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
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
