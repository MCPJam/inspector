import { Plus, MoreVertical, Copy, Trash2, BarChart3, Pencil } from "lucide-react";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import type { EvalCase } from "./types";

interface TestCaseListSidebarProps {
  testCases: EvalCase[];
  suiteId: string | null;
  selectedTestId: string | null;
  isLoading: boolean;
  onCreateTestCase: () => void;
  onDeleteTestCase: (testCaseId: string, testCaseTitle: string) => void;
  onDuplicateTestCase: (testCaseId: string) => void;
  deletingTestCaseId: string | null;
  duplicatingTestCaseId: string | null;
  showingOverview: boolean;
  noServerSelected?: boolean;
}

export function TestCaseListSidebar({
  testCases,
  suiteId,
  selectedTestId,
  isLoading,
  onCreateTestCase,
  onDeleteTestCase,
  onDuplicateTestCase,
  deletingTestCaseId,
  duplicatingTestCaseId,
  showingOverview,
  noServerSelected,
}: TestCaseListSidebarProps) {
  const handleNavigateToOverview = () => {
    if (suiteId) {
      navigateToEvalsRoute({ type: "suite-overview", suiteId });
    }
  };

  if (noServerSelected) {
    return (
      <>
        <div className="p-4 border-b">
          <h2 className="text-sm font-semibold">Test Cases</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-muted-foreground text-center">
            Select a server to view test cases
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="text-sm font-semibold">Test Cases</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            posthog.capture("create_test_case_button_clicked", {
              location: "test_case_list_sidebar",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            onCreateTestCase();
          }}
          className="h-7 w-7 p-0"
          title="Create new test case"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Results Overview Button */}
      {suiteId && (
        <div
          className={cn(
            "group flex items-center gap-2 px-4 py-2.5 text-sm cursor-pointer transition-colors border-b",
            "hover:bg-accent/50",
            showingOverview && "bg-accent font-medium",
          )}
        >
          <div
            onClick={handleNavigateToOverview}
            className="flex items-center gap-2 flex-1"
          >
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <span>Results & Runs</span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigateToEvalsRoute({ type: "suite-edit", suiteId });
            }}
            className="shrink-0 p-1 hover:bg-accent rounded transition-colors opacity-0 group-hover:opacity-100"
            title="Edit test suite settings"
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      )}

      {/* Test Cases List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading test cases...
          </div>
        ) : testCases.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No test cases yet
          </div>
        ) : (
          <div className="py-2">
            {testCases.map((testCase) => {
              const isTestSelected = selectedTestId === testCase._id;
              const isTestDeleting = deletingTestCaseId === testCase._id;
              const isTestDuplicating = duplicatingTestCaseId === testCase._id;

              return (
                <div
                  key={testCase._id}
                  onClick={() => {
                    if (suiteId) {
                      navigateToEvalsRoute({
                        type: "test-edit",
                        suiteId: suiteId,
                        testId: testCase._id,
                      });
                    }
                  }}
                  className={cn(
                    "group w-full flex items-center gap-1 px-4 py-2 text-left text-sm hover:bg-accent/50 transition-colors cursor-pointer",
                    isTestSelected && "bg-accent font-medium",
                  )}
                >
                  <div className="flex-1 min-w-0 text-left">
                    <div className="truncate">{testCase.title}</div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 p-1 hover:bg-accent/50 rounded transition-colors opacity-0 group-hover:opacity-100"
                        aria-label="Test case options"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onDuplicateTestCase(testCase._id);
                        }}
                        disabled={isTestDuplicating}
                      >
                        <Copy className="h-4 w-4 mr-2 text-foreground" />
                        {isTestDuplicating ? "Duplicating..." : "Duplicate"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteTestCase(testCase._id, testCase.title);
                        }}
                        disabled={isTestDeleting}
                        variant="destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {isTestDeleting ? "Deleting..." : "Delete"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
