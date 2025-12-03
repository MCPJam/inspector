import { Plus } from "lucide-react";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import { SuiteSidebarItem } from "./SuiteSidebarItem";
import type { EvalSuiteOverviewEntry, EvalSuite } from "./types";

interface SuiteListSidebarProps {
  sortedSuites: EvalSuiteOverviewEntry[];
  isOverviewLoading: boolean;
  selectedSuiteId: string | null;
  selectedTestIdForSidebar: string | null;
  expandedSuites: Set<string>;
  onToggleSuiteExpanded: (suiteId: string) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onDelete: (suite: EvalSuite) => void;
  onDuplicate: (suite: EvalSuite) => void;
  onCreateTestCase: (suiteId: string) => void;
  onDeleteTestCase: (testCaseId: string, testCaseTitle: string) => void;
  onDuplicateTestCase: (testCaseId: string, suiteId: string) => void;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  duplicatingSuiteId: string | null;
  deletingTestCaseId: string | null;
  duplicatingTestCaseId: string | null;
  connectedServerNames: Set<string>;
}

export function SuiteListSidebar({
  sortedSuites,
  isOverviewLoading,
  selectedSuiteId,
  selectedTestIdForSidebar,
  expandedSuites,
  onToggleSuiteExpanded,
  onRerun,
  onCancelRun,
  onDelete,
  onDuplicate,
  onCreateTestCase,
  onDeleteTestCase,
  onDuplicateTestCase,
  rerunningSuiteId,
  cancellingRunId,
  deletingSuiteId,
  duplicatingSuiteId,
  deletingTestCaseId,
  duplicatingTestCaseId,
  connectedServerNames,
}: SuiteListSidebarProps) {
  return (
    <>
      {/* Header */}
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="text-sm font-semibold">Testsuites</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            posthog.capture("create_new_run_button_clicked", {
              location: "suite_list_sidebar",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            navigateToEvalsRoute({ type: "create" });
          }}
          className="h-7 w-7 p-0"
          title="Create new test suite"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Suites List */}
      <div className="flex-1 overflow-y-auto">
        {isOverviewLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading suites...
          </div>
        ) : sortedSuites.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No test suites yet
          </div>
        ) : (
          <div className="py-2">
            {sortedSuites.map((entry) => {
              const { suite, latestRun } = entry;
              return (
                <SuiteSidebarItem
                  key={suite._id}
                  suite={suite}
                  latestRun={latestRun}
                  isSelected={selectedSuiteId === suite._id}
                  isExpanded={expandedSuites.has(suite._id)}
                  selectedTestId={selectedTestIdForSidebar}
                  onToggleExpanded={onToggleSuiteExpanded}
                  onRerun={onRerun}
                  onCancelRun={onCancelRun}
                  onDelete={onDelete}
                  onDuplicate={onDuplicate}
                  onCreateTestCase={onCreateTestCase}
                  onDeleteTestCase={onDeleteTestCase}
                  onDuplicateTestCase={onDuplicateTestCase}
                  isRerunning={rerunningSuiteId === suite._id}
                  isCancelling={cancellingRunId === latestRun?._id}
                  isDeleting={deletingSuiteId === suite._id}
                  isDuplicating={duplicatingSuiteId === suite._id}
                  deletingTestCaseId={deletingTestCaseId}
                  duplicatingTestCaseId={duplicatingTestCaseId}
                  connectedServerNames={connectedServerNames}
                />
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
