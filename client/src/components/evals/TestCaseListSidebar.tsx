import {
  Plus,
  MoreVertical,
  Copy,
  Trash2,
  BarChart3,
  Sparkles,
  RotateCw,
  Loader2,
} from "lucide-react";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import type { EvalCase, EvalSuite } from "./types";

interface TestCaseListSidebarProps {
  testCases: EvalCase[];
  suiteId: string | null;
  selectedTestId: string | null;
  isLoading: boolean;
  onCreateTestCase: () => void;
  onDeleteTestCase: (testCaseId: string, testCaseTitle: string) => void;
  onDuplicateTestCase: (testCaseId: string) => void;
  onGenerateTests?: () => void;
  deletingTestCaseId: string | null;
  duplicatingTestCaseId: string | null;
  isGeneratingTests?: boolean;
  showingOverview: boolean;
  noServerSelected?: boolean;
  // Rerun props
  suite?: EvalSuite | null;
  onRerun?: (suite: EvalSuite) => void;
  rerunningSuiteId?: string | null;
  connectedServerNames?: Set<string>;
}

export function TestCaseListSidebar({
  testCases,
  suiteId,
  selectedTestId,
  isLoading,
  onCreateTestCase,
  onDeleteTestCase,
  onDuplicateTestCase,
  onGenerateTests,
  deletingTestCaseId,
  duplicatingTestCaseId,
  isGeneratingTests,
  showingOverview,
  noServerSelected,
  suite,
  onRerun,
  rerunningSuiteId,
  connectedServerNames,
}: TestCaseListSidebarProps) {
  // Calculate rerun availability
  const suiteServers = suite?.environment?.servers || [];
  const missingServers = suiteServers.filter(
    (server) => !connectedServerNames?.has(server),
  );
  const canRerun = missingServers.length === 0 && suite && onRerun;
  const isRerunning = rerunningSuiteId === suite?._id;
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
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (suite && onRerun) {
                      posthog.capture("rerun_suite_button_clicked", {
                        location: "test_case_list_sidebar",
                        platform: detectPlatform(),
                        environment: detectEnvironment(),
                      });
                      onRerun(suite);
                    }
                  }}
                  disabled={!canRerun || isRerunning || testCases.length === 0}
                  className="h-7 w-7 p-0"
                >
                  <RotateCw
                    className={cn("h-4 w-4", isRerunning && "animate-spin")}
                  />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {testCases.length === 0
                ? "Add test cases first"
                : !canRerun && missingServers.length > 0
                  ? `Connect the following servers: ${missingServers.join(", ")}`
                  : isRerunning
                    ? "Running..."
                    : "Run all tests"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (onGenerateTests) {
                      posthog.capture("generate_tests_button_clicked", {
                        location: "test_case_list_sidebar",
                        platform: detectPlatform(),
                        environment: detectEnvironment(),
                      });
                      onGenerateTests();
                    }
                  }}
                  disabled={isGeneratingTests || !onGenerateTests}
                  className="h-7 w-7 p-0"
                >
                  <Sparkles
                    className={cn(
                      "h-4 w-4",
                      isGeneratingTests && "animate-pulse",
                    )}
                  />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {isGeneratingTests
                ? "Generating..."
                : "Generate test cases with AI"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
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
              >
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Create new test case</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Results Overview Button */}
      {suiteId && (
        <div
          onClick={handleNavigateToOverview}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm cursor-pointer transition-colors border-b",
            "hover:bg-accent/50",
            showingOverview && "bg-accent font-medium",
          )}
        >
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <span>Results & Runs</span>
        </div>
      )}

      {/* Test Cases List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading test cases...
          </div>
        ) : isGeneratingTests ? (
          <div className="p-4 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Generating test cases...</span>
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
                  <div className="flex-1 min-w-0 text-left flex items-center gap-1.5">
                    <span className="truncate">{testCase.title}</span>
                    {testCase.isNegativeTest && (
                      <span
                        className="text-[10px] text-orange-500 shrink-0"
                        title="Negative test"
                      >
                        NEG
                      </span>
                    )}
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
