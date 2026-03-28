import { ExploreCasesList } from "./explore-cases-list";
import { RunIterationsSidebar } from "./run-detail-view";
import {
  navigateToCiEvalsRoute,
  type CiEvalsRoute,
} from "@/lib/ci-evals-router";
import type { EvalCase, EvalIteration, SuiteAggregate } from "./types";

interface CiEvalsSuiteDrilldownSidebarProps {
  route: CiEvalsRoute;
  cases: EvalCase[];
  aggregate: SuiteAggregate | null;
  activeIterations: EvalIteration[];
  isCasesLoading: boolean;
  selectedTestId: string | null;
  onSelectCase: (testCaseId: string) => void;
  caseGroupsForSelectedRun: EvalIteration[];
  runDetailSortBy: "model" | "test" | "result";
  onRunDetailSortChange: (sort: "model" | "test" | "result") => void;
  selectedIterationId: string | null;
  onSelectIteration: (iterationId: string) => void;
}

export function CiEvalsSuiteDrilldownSidebar({
  route,
  cases,
  aggregate,
  activeIterations,
  isCasesLoading,
  selectedTestId,
  onSelectCase,
  caseGroupsForSelectedRun,
  runDetailSortBy,
  onRunDetailSortChange,
  selectedIterationId,
  onSelectIteration,
}: CiEvalsSuiteDrilldownSidebarProps) {
  const isRunDetail = route.type === "run-detail";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isRunDetail ? (
        <RunIterationsSidebar
          caseGroupsForSelectedRun={caseGroupsForSelectedRun}
          runDetailSortBy={runDetailSortBy}
          onSortChange={onRunDetailSortChange}
          selectedIterationId={selectedIterationId}
          onSelectIteration={onSelectIteration}
          onEditTestCase={(testCaseId) =>
            navigateToCiEvalsRoute({
              type: "test-edit",
              suiteId: route.suiteId,
              testId: testCaseId,
            })
          }
        />
      ) : (
        <ExploreCasesList
          cases={cases}
          aggregate={aggregate}
          iterations={activeIterations}
          isLoading={isCasesLoading}
          onRowClick={onSelectCase}
          variant="sidebar"
          selectedCaseId={selectedTestId}
        />
      )}
    </div>
  );
}
