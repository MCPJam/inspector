import { useMemo } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import type { EvalCase, EvalSuite, EvalSuiteRun } from "./types";
import { getSuiteReplayEligibility } from "./replay-eligibility";
import {
  formatCaseTitleForSidebar,
  getEvalCaseSidebarGroupKey,
  groupEvalCasesForSidebar,
} from "./case-name-utils";

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
  selectedServer?: string;
  // Rerun props
  suite?: EvalSuite | null;
  latestRun?: EvalSuiteRun | null;
  onRerun?: (suite: EvalSuite) => void;
  rerunningSuiteId?: string | null;
  connectedServerNames?: Set<string>;
  onNavigateToOverview?: (suiteId: string) => void;
  onSelectTestCase?: (suiteId: string, testCaseId: string) => void;
  heading?: string;
  emptyLabel?: string;
  onToggleSelection?: (testCaseId: string, selected: boolean) => void;
  selectedCaseIds?: string[];
  showSelection?: boolean;
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
  selectedServer,
  suite,
  latestRun,
  onRerun,
  rerunningSuiteId,
  connectedServerNames,
  onNavigateToOverview,
  onSelectTestCase,
  heading = "Cases",
  emptyLabel = "No cases yet",
  onToggleSelection,
  selectedCaseIds = [],
  showSelection = false,
}: TestCaseListSidebarProps) {
  // Calculate rerun availability
  const rerunEligibility = getSuiteReplayEligibility({
    suiteServers: suite?.environment?.servers,
    connectedServerNames,
    latestRun,
  });
  const missingServers = rerunEligibility.missingServers;
  const canRerun = rerunEligibility.canRunNow && suite && onRerun;
  const isRerunning = rerunningSuiteId === suite?._id;
  const handleNavigateToOverview = () => {
    if (suiteId) {
      if (onNavigateToOverview) {
        onNavigateToOverview(suiteId);
        return;
      }
      navigateToEvalsRoute({ type: "suite-overview", suiteId });
    }
  };

  const sidebarCaseGroups = useMemo(
    () => groupEvalCasesForSidebar(testCases),
    [testCases],
  );

  if (noServerSelected) {
    return (
      <>
        <div className="p-4 border-b">
          <h2 className="text-sm font-semibold">{heading}</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-muted-foreground text-center">
            Select a server to view cases.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {heading}
          {selectedServer && (
            <span className="text-muted-foreground font-normal">
              {" "}
              [{selectedServer}]
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Run suite"
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
                ? "Add cases first"
                : rerunEligibility.canReplayFallback
                  ? "Run all cases using saved replay config"
                  : !canRerun && missingServers.length > 0
                    ? `Connect the following servers: ${missingServers.join(", ")}`
                    : isRerunning
                      ? "Running..."
                      : "Run all cases"}
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
              {isGeneratingTests ? "Generating..." : "Generate cases with AI"}
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
            <TooltipContent>Create new case</TooltipContent>
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
          <span>Runs</span>
        </div>
      )}

      {/* Cases List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading cases...
          </div>
        ) : isGeneratingTests ? (
          <div className="p-4 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Generating cases...</span>
          </div>
        ) : testCases.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          <div className="py-2">
            {sidebarCaseGroups.map(({ groupKey, cases: groupCases }) => {
              const showGroupLabel =
                groupCases.length > 1 ||
                groupCases.some(
                  (c) =>
                    getEvalCaseSidebarGroupKey(c.title || "") !==
                    c.title?.trim(),
                );

              return (
                <div key={groupKey} className="mb-1">
                  {showGroupLabel ? (
                    <div
                      className="px-4 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground truncate"
                      title={groupKey}
                    >
                      {groupKey}
                    </div>
                  ) : null}
                  {groupCases.map((testCase) => {
                    const isTestSelected = selectedTestId === testCase._id;
                    const isTestDeleting = deletingTestCaseId === testCase._id;
                    const isTestDuplicating =
                      duplicatingTestCaseId === testCase._id;
                    const isCaseChecked = selectedCaseIds.includes(
                      testCase._id,
                    );
                    const { line1, line2, fullTitle } =
                      formatCaseTitleForSidebar(testCase.title || "");

                    return (
                      <div
                        key={testCase._id}
                        onClick={() => {
                          if (suiteId) {
                            if (onSelectTestCase) {
                              onSelectTestCase(suiteId, testCase._id);
                              return;
                            }
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
                        title={fullTitle}
                      >
                        {showSelection && (
                          <Checkbox
                            checked={isCaseChecked}
                            onCheckedChange={(checked) => {
                              onToggleSelection?.(
                                testCase._id,
                                checked === true,
                              );
                            }}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${fullTitle}`}
                          />
                        )}
                        <div className="flex-1 min-w-0 text-left flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate leading-tight">
                              {line1}
                            </span>
                            {testCase.isNegativeTest && (
                              <span
                                className="text-[10px] text-orange-500 shrink-0"
                                title="Negative case"
                              >
                                NEG
                              </span>
                            )}
                          </div>
                          {line2 ? (
                            <span
                              className="truncate text-[11px] text-muted-foreground leading-tight"
                              title={fullTitle}
                            >
                              {line2}
                            </span>
                          ) : null}
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className="shrink-0 p-1 hover:bg-accent/50 rounded transition-colors opacity-0 group-hover:opacity-100"
                              aria-label="Case options"
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
                              {isTestDuplicating
                                ? "Duplicating..."
                                : "Duplicate"}
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
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
