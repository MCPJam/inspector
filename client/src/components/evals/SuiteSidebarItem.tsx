import { useConvexAuth, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import {
  ChevronDown,
  ChevronRight,
  MoreVertical,
  Plus,
  RotateCw,
  X,
  Pencil,
  Copy,
  Trash2,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import type { EvalSuite, EvalSuiteRun } from "./types";

interface SuiteSidebarItemProps {
  suite: EvalSuite;
  latestRun: EvalSuiteRun | null | undefined;
  isSelected: boolean;
  isExpanded: boolean;
  selectedTestId: string | null;
  onToggleExpanded: (suiteId: string) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onDelete: (suite: EvalSuite) => void;
  onDuplicate: (suite: EvalSuite) => void;
  onCreateTestCase: (suiteId: string) => void;
  onDeleteTestCase: (testCaseId: string, testCaseTitle: string) => void;
  onDuplicateTestCase: (testCaseId: string, suiteId: string) => void;
  isRerunning: boolean;
  isCancelling: boolean;
  isDeleting: boolean;
  isDuplicating: boolean;
  deletingTestCaseId: string | null;
  duplicatingTestCaseId: string | null;
  connectedServerNames: Set<string>;
}

export function SuiteSidebarItem({
  suite,
  latestRun,
  isSelected,
  isExpanded,
  selectedTestId,
  onToggleExpanded,
  onRerun,
  onCancelRun,
  onDelete,
  onDuplicate,
  onCreateTestCase,
  onDeleteTestCase,
  onDuplicateTestCase,
  isRerunning,
  isCancelling,
  isDeleting,
  isDuplicating,
  deletingTestCaseId,
  duplicatingTestCaseId,
  connectedServerNames,
}: SuiteSidebarItemProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();

  // Load test cases for all suites upfront (for smoother UX), but skip if deleting
  const enableTestCasesQuery = isAuthenticated && !!user && !isDeleting;
  const testCases = useQuery(
    "testSuites:listTestCases" as any,
    enableTestCasesQuery ? ({ suiteId: suite._id } as any) : "skip",
  ) as any[] | undefined;

  // Check for missing servers
  const suiteServers = suite.environment?.servers || [];
  const missingServers = suiteServers.filter(
    (server) => !connectedServerNames.has(server),
  );
  const hasMissingServers = missingServers.length > 0;

  // Check if there's an active run (pending or running)
  const hasActiveRun =
    latestRun &&
    (latestRun.status === "pending" || latestRun.status === "running");

  // Determine status for the dot indicator
  const getStatusColor = () => {
    // If servers are disconnected, show grey dot
    if (hasMissingServers) return "bg-muted-foreground";

    if (!latestRun) return "bg-muted-foreground"; // cancelled/no runs

    // Use result if available, otherwise infer from status
    if (latestRun.result === "passed") return "bg-success";
    if (latestRun.result === "failed") return "bg-destructive";
    if (latestRun.result === "cancelled") return "bg-muted-foreground";
    if (latestRun.result === "pending" || latestRun.status === "pending")
      return "bg-warning";
    if (latestRun.status === "running") return "bg-warning";

    // Fallback based on status
    if (latestRun.status === "completed") {
      // Check pass rate
      const passRate = latestRun.summary?.passRate ?? 0;
      const minimumPassRate = latestRun.passCriteria?.minimumPassRate ?? 100;
      return passRate >= minimumPassRate ? "bg-success" : "bg-destructive";
    }
    if (latestRun.status === "cancelled") return "bg-muted-foreground";

    return "bg-muted-foreground";
  };

  return (
    <div>
      <div
        onClick={() =>
          navigateToEvalsRoute({ type: "suite-overview", suiteId: suite._id })
        }
        className={cn(
          "group w-full flex items-center gap-1 px-4 py-2 text-left text-sm transition-colors hover:bg-accent/50 cursor-pointer",
          isSelected && !selectedTestId && "bg-accent",
        )}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpanded(suite._id);
          }}
          className="shrink-0 p-1 hover:bg-accent/50 rounded transition-colors"
          aria-label={isExpanded ? "Collapse suite" : "Expand suite"}
        >
          {isExpanded && testCases ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4 opacity-50" />
          )}
        </button>
        <div
          className={cn(
            "flex-1 min-w-0 text-left rounded px-2 py-1 transition-colors",
            isSelected && !selectedTestId && "font-medium",
          )}
        >
          <div className="flex items-center gap-1.5 truncate">
            <span className="truncate font-medium">
              {suite.name || "Untitled suite"}
            </span>
            <div
              className={cn(
                "h-1.5 w-1.5 rounded-full shrink-0",
                getStatusColor(),
              )}
            />
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCreateTestCase(suite._id);
          }}
          className="shrink-0 p-1 hover:bg-accent/50 rounded transition-colors"
          aria-label="Create test case"
        >
          <Plus className="h-4 w-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 p-1 hover:bg-accent/50 rounded transition-colors"
              aria-label="Suite options"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {hasActiveRun ? (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  if (latestRun && !isCancelling) {
                    onCancelRun(latestRun._id);
                  }
                }}
                disabled={isCancelling}
              >
                <X
                  className={cn(
                    "h-4 w-4 mr-2 text-foreground",
                    isCancelling && "opacity-50",
                  )}
                />
                {isCancelling ? "Cancelling..." : "Cancel run"}
              </DropdownMenuItem>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!hasMissingServers && !isRerunning) {
                          onRerun(suite);
                        }
                      }}
                      disabled={hasMissingServers || isRerunning}
                      className={hasMissingServers ? "cursor-not-allowed" : ""}
                    >
                      <RotateCw
                        className={cn(
                          "h-4 w-4 mr-2 text-foreground",
                          (hasMissingServers || isRerunning) && "opacity-50",
                          isRerunning && "animate-spin",
                        )}
                      />
                      {isRerunning ? "Running..." : "Rerun"}
                    </DropdownMenuItem>
                  </div>
                </TooltipTrigger>
                {hasMissingServers && (
                  <TooltipContent>
                    Missing servers: {missingServers.join(", ")}
                  </TooltipContent>
                )}
              </Tooltip>
            )}
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                navigateToEvalsRoute({
                  type: "suite-edit",
                  suiteId: suite._id,
                });
              }}
            >
              <Pencil className="h-4 w-4 mr-2 text-foreground" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate(suite);
              }}
              disabled={isDuplicating}
            >
              <Copy className="h-4 w-4 mr-2 text-foreground" />
              {isDuplicating ? "Duplicating..." : "Duplicate"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDelete(suite);
              }}
              disabled={isDeleting}
              variant="destructive"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {isDeleting ? "Deleting..." : "Delete"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Test Cases List */}
      {isExpanded && (
        <div className="pb-2">
          {!testCases ? (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">
              Loading...
            </div>
          ) : testCases.length === 0 ? (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">
              No test cases
            </div>
          ) : (
            testCases.map((testCase: any) => {
              const isTestSelected = selectedTestId === testCase._id;
              const isTestDeleting = deletingTestCaseId === testCase._id;
              const isTestDuplicating = duplicatingTestCaseId === testCase._id;

              return (
                <div
                  key={testCase._id}
                  onClick={() => {
                    navigateToEvalsRoute({
                      type: "test-edit",
                      suiteId: suite._id,
                      testId: testCase._id,
                    });
                  }}
                  className={cn(
                    "group w-full flex items-center gap-1 pl-6 pr-4 py-2 text-left text-xs hover:bg-accent/50 transition-colors cursor-pointer",
                    isTestSelected && "bg-accent/70 font-medium",
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
                          onDuplicateTestCase(testCase._id, suite._id);
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
            })
          )}
        </div>
      )}
    </div>
  );
}
