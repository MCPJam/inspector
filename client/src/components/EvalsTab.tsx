import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery, useMutation, useConvex } from "convex/react";
import {
  FlaskConical,
  Plus,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  MoreVertical,
  RotateCw,
  Trash2,
  X,
  Pencil,
  Copy,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
  SuiteDetailsQueryResponse,
} from "./evals/types";
import { aggregateSuite } from "./evals/helpers";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { EvalRunner } from "./evals/eval-runner";
import { useChat } from "@/hooks/use-chat";
import { useAppState } from "@/hooks/use-app-state";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel } from "@/shared/types";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import posthog from "posthog-js";
import { useEvalsRoute, navigateToEvalsRoute } from "@/lib/evals-router";
// Component to render a single suite in the sidebar with its own data loading
function SuiteSidebarItem({
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
}: {
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
}) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();

  // Load test cases for all suites upfront (for smoother UX)
  const enableTestCasesQuery = isAuthenticated && !!user;
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
    if (hasMissingServers) return "bg-gray-400";

    if (!latestRun) return "bg-gray-400"; // cancelled/no runs

    // Use result if available, otherwise infer from status
    if (latestRun.result === "passed") return "bg-emerald-500";
    if (latestRun.result === "failed") return "bg-red-500";
    if (latestRun.result === "cancelled") return "bg-gray-400";
    if (latestRun.result === "pending" || latestRun.status === "pending")
      return "bg-amber-400";
    if (latestRun.status === "running") return "bg-amber-400";

    // Fallback based on status
    if (latestRun.status === "completed") {
      // Check pass rate
      const passRate = latestRun.summary?.passRate ?? 0;
      const minimumPassRate = latestRun.passCriteria?.minimumPassRate ?? 100;
      return passRate >= minimumPassRate ? "bg-emerald-500" : "bg-red-500";
    }
    if (latestRun.status === "cancelled") return "bg-gray-400";

    return "bg-gray-400";
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

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user, getAccessToken } = useAuth();
  const convex = useConvex();

  // Use route-based navigation instead of state
  const route = useEvalsRoute();

  // Derive state from route
  const selectedSuiteId =
    route.type === "suite-overview" ||
    route.type === "run-detail" ||
    route.type === "test-detail" ||
    route.type === "test-edit" ||
    route.type === "suite-edit"
      ? route.suiteId
      : null;

  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;

  // Only highlight test in sidebar when editing (not when viewing history)
  const selectedTestIdForSidebar =
    route.type === "test-edit" ? route.testId : null;

  // Modal and action states (not navigation)
  const [rerunningSuiteId, setRerunningSuiteId] = useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [deletingSuiteId, setDeletingSuiteId] = useState<string | null>(null);
  const [suiteToDelete, setSuiteToDelete] = useState<EvalSuite | null>(null);
  const [duplicatingSuiteId, setDuplicatingSuiteId] = useState<string | null>(
    null,
  );
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [runToDelete, setRunToDelete] = useState<string | null>(null);
  const [isCreatingTestCase, setIsCreatingTestCase] = useState(false);
  const [deletingTestCaseId, setDeletingTestCaseId] = useState<string | null>(
    null,
  );
  const [duplicatingTestCaseId, setDuplicatingTestCaseId] = useState<
    string | null
  >(null);
  const [testCaseToDelete, setTestCaseToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);

  // Track expanded suites based on current route
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (selectedSuiteId) {
      initial.add(selectedSuiteId);
    }
    return initial;
  });

  // Auto-expand the currently selected suite
  useEffect(() => {
    if (selectedSuiteId) {
      setExpandedSuites((prev) => new Set(prev).add(selectedSuiteId));
    }
  }, [selectedSuiteId]);

  // Toggle expanded state for a specific suite
  const toggleSuiteExpanded = useCallback((suiteId: string) => {
    setExpandedSuites((prev) => {
      const next = new Set(prev);
      if (next.has(suiteId)) {
        next.delete(suiteId);
      } else {
        next.add(suiteId);
      }
      return next;
    });
  }, []);

  const { availableModels } = useChat({
    systemPrompt: "",
    temperature: 1,
    selectedServers: [],
  });

  const { appState } = useAppState();
  const { getToken, hasToken } = useAiProviderKeys();

  const deleteSuiteMutation = useMutation("testSuites:deleteTestSuite" as any);
  const deleteRunMutation = useMutation("testSuites:deleteTestSuiteRun" as any);
  const cancelRunMutation = useMutation("testSuites:cancelTestSuiteRun" as any);
  const duplicateSuiteMutation = useMutation(
    "testSuites:duplicateTestSuite" as any,
  );
  const createTestCaseMutation = useMutation(
    "testSuites:createTestCase" as any,
  );
  const deleteTestCaseMutation = useMutation(
    "testSuites:deleteTestCase" as any,
  );
  const duplicateTestCaseMutation = useMutation(
    "testSuites:duplicateTestCase" as any,
  );

  useEffect(() => {
    posthog.capture("evals_tab_viewed", {
      location: "evals_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

  // Get connected server names
  const connectedServerNames = useMemo(
    () =>
      new Set(
        Object.entries(appState.servers)
          .filter(([, server]) => server.connectionStatus === "connected")
          .map(([name]) => name),
      ),
    [appState.servers],
  );

  const enableOverviewQuery = isAuthenticated && !!user;
  const suiteOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    enableOverviewQuery ? ({} as any) : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  const enableSuiteDetailsQuery =
    isAuthenticated && !!user && !!selectedSuiteId;
  const suiteDetails = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip",
  ) as SuiteDetailsQueryResponse | undefined;

  const suiteRuns = useQuery(
    "testSuites:listTestSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 20 } as any)
      : "skip",
  ) as EvalSuiteRun[] | undefined;

  const isOverviewLoading = suiteOverview === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;

  const isSuiteRunsLoading = enableSuiteDetailsQuery && suiteRuns === undefined;

  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId || !suiteOverview) return null;
    return (
      suiteOverview.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [selectedSuiteId, suiteOverview]);

  const selectedSuite = selectedSuiteEntry?.suite ?? null;

  const sortedIterations = useMemo(() => {
    if (!suiteDetails) return [];
    return [...suiteDetails.iterations].sort(
      (a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt),
    );
  }, [suiteDetails]);

  const runsForSelectedSuite = useMemo(
    () => (suiteRuns ? [...suiteRuns] : []),
    [suiteRuns],
  );

  // Filter iterations to only include those from active runs
  const activeIterations = useMemo(() => {
    if (!suiteRuns || sortedIterations.length === 0) return sortedIterations;

    const activeRunIds = new Set(
      suiteRuns.filter((run) => run.isActive !== false).map((run) => run._id),
    );

    return sortedIterations.filter(
      (iteration) =>
        !iteration.suiteRunId || activeRunIds.has(iteration.suiteRunId),
    );
  }, [sortedIterations, suiteRuns]);

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      activeIterations,
    );
  }, [selectedSuite, suiteDetails, activeIterations]);

  // Query to get test cases for a suite
  const getTestCasesForRerun = useCallback(
    async (suiteId: string) => {
      try {
        const testCases = await convex.query(
          "testSuites:listTestCases" as any,
          { suiteId },
        );
        return testCases;
      } catch (error) {
        console.error("Failed to fetch test cases:", error);
        return [];
      }
    },
    [convex],
  );

  // Rerun handler
  const handleRerun = useCallback(
    async (suite: EvalSuite) => {
      if (rerunningSuiteId) return;

      const suiteServers = suite.environment?.servers || [];

      // Get current test cases from database (not from stale config)
      const testCases = (await getTestCasesForRerun(suite._id)) as any[];
      if (!testCases || testCases.length === 0) {
        toast.error("No test cases found in this suite");
        return;
      }

      // Generate tests array by expanding each test case's models
      const tests: any[] = [];

      for (const testCase of testCases) {
        // Skip test cases with no models
        if (!testCase.models || testCase.models.length === 0) {
          continue;
        }

        // Create one test per model
        for (const modelConfig of testCase.models) {
          tests.push({
            title: testCase.title,
            query: testCase.query,
            runs: testCase.runs || 1,
            model: modelConfig.model,
            provider: modelConfig.provider,
            expectedToolCalls: testCase.expectedToolCalls || [],
            advancedConfig: testCase.advancedConfig,
            testCaseId: testCase._id,
          });
        }
      }

      if (tests.length === 0) {
        toast.error("No tests to run. Please add models to your test cases.");
        return;
      }

      // Collect API keys for all providers used in the tests
      const modelApiKeys: Record<string, string> = {};
      const providersNeeded = new Set<string>();

      for (const test of tests) {
        if (!isMCPJamProvidedModel(test.model)) {
          providersNeeded.add(test.provider);
        }
      }

      // Check that we have all required API keys
      for (const provider of providersNeeded) {
        const tokenKey = provider.toLowerCase() as keyof ProviderTokens;
        if (!hasToken(tokenKey)) {
          toast.error(
            `Please add your ${provider} API key in Settings before running evals`,
          );
          return;
        }
        const key = getToken(tokenKey);
        if (key) {
          modelApiKeys[provider] = key;
        }
      }

      setRerunningSuiteId(suite._id);

      // Show toast immediately when user clicks rerun
      toast.success(
        "Eval run started successfully! Results will appear shortly.",
      );

      try {
        const accessToken = await getAccessToken();

        // Get pass criteria from suite's defaultPassCriteria, or fall back to latest run, or default to 100%
        const suiteDefault = suite.defaultPassCriteria?.minimumPassRate;
        const latestRun = selectedSuiteEntry?.latestRun;
        const minimumPassRate =
          suiteDefault ?? latestRun?.passCriteria?.minimumPassRate ?? 100;
        const criteriaNote = `Pass Criteria: Min ${minimumPassRate}% Accuracy`;

        const response = await fetch("/api/mcp/evals/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            suiteId: suite._id,
            suiteName: suite.name,
            suiteDescription: suite.description,
            tests: tests.map((test) => ({
              title: test.title,
              query: test.query,
              runs: test.runs ?? 1,
              model: test.model,
              provider: test.provider,
              expectedToolCalls: test.expectedToolCalls,
              advancedConfig: test.advancedConfig,
            })),
            serverIds: suiteServers,
            modelApiKeys:
              Object.keys(modelApiKeys).length > 0 ? modelApiKeys : undefined,
            convexAuthToken: accessToken,
            passCriteria: {
              minimumPassRate: minimumPassRate,
            },
            notes: criteriaNote,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "Failed to start eval run");
        }

        // Track suite run started
        posthog.capture("eval_suite_run_started", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suite._id,
          num_test_cases: testCases.length,
          num_tests: tests.length,
          num_models: providersNeeded.size,
          minimum_pass_rate: minimumPassRate,
        });

        // Optionally show completion toast
        toast.success("Eval run completed!");
      } catch (error) {
        console.error("Failed to rerun evals:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to start eval run",
        );
      } finally {
        setRerunningSuiteId(null);
      }
    },
    [
      rerunningSuiteId,
      selectedSuiteEntry,
      getAccessToken,
      hasToken,
      getToken,
      getTestCasesForRerun,
    ],
  );

  // Delete handler - opens confirmation modal
  const handleDelete = useCallback(
    (suite: EvalSuite) => {
      if (deletingSuiteId) return;
      setSuiteToDelete(suite);
    },
    [deletingSuiteId],
  );

  // Confirm deletion - actually performs the deletion
  const confirmDelete = useCallback(async () => {
    if (!suiteToDelete || deletingSuiteId) return;

    setDeletingSuiteId(suiteToDelete._id);

    try {
      await deleteSuiteMutation({ suiteId: suiteToDelete._id });
      toast.success("Test suite deleted successfully");

      // If we're viewing this suite, go back to the list
      if (selectedSuiteId === suiteToDelete._id) {
        navigateToEvalsRoute({ type: "list" });
      }

      setSuiteToDelete(null);
    } catch (error) {
      console.error("Failed to delete suite:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete test suite",
      );
    } finally {
      setDeletingSuiteId(null);
    }
  }, [suiteToDelete, deletingSuiteId, deleteSuiteMutation, selectedSuiteId]);

  // Duplicate suite handler
  const handleDuplicateSuite = useCallback(
    async (suite: EvalSuite) => {
      if (duplicatingSuiteId) return;

      setDuplicatingSuiteId(suite._id);

      try {
        const newSuite = await duplicateSuiteMutation({ suiteId: suite._id });
        toast.success("Test suite duplicated successfully");

        // Track suite duplicated
        if (newSuite && newSuite._id) {
          posthog.capture("eval_suite_duplicated", {
            location: "evals_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            original_suite_id: suite._id,
            new_suite_id: newSuite._id,
          });
        }

        // Navigate to the new duplicated suite
        if (newSuite && newSuite._id) {
          navigateToEvalsRoute({
            type: "suite-overview",
            suiteId: newSuite._id,
          });
        }
      } catch (error) {
        console.error("Failed to duplicate suite:", error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to duplicate test suite",
        );
      } finally {
        setDuplicatingSuiteId(null);
      }
    },
    [duplicatingSuiteId, duplicateSuiteMutation],
  );

  // Cancel handler
  const handleCancelRun = useCallback(
    async (runId: string) => {
      if (cancellingRunId) return;

      setCancellingRunId(runId);

      try {
        await cancelRunMutation({ runId });
        toast.success("Run cancelled successfully");
      } catch (error) {
        console.error("Failed to cancel run:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to cancel run",
        );
      } finally {
        setCancellingRunId(null);
      }
    },
    [cancellingRunId, cancelRunMutation],
  );

  // Delete run handler - opens confirmation modal (for single run from detail view)
  const handleDeleteRun = useCallback(
    (runId: string) => {
      if (deletingRunId) return;
      setRunToDelete(runId);
    },
    [deletingRunId],
  );

  // Direct delete function - actually performs the deletion (for batch delete)
  const directDeleteRun = useCallback(
    async (runId: string) => {
      try {
        await deleteRunMutation({ runId });
      } catch (error) {
        console.error("Failed to delete run:", error);
        throw error;
      }
    },
    [deleteRunMutation],
  );

  // Confirm run deletion - actually performs the deletion
  const confirmDeleteRun = useCallback(async () => {
    if (!runToDelete || deletingRunId) return;

    setDeletingRunId(runToDelete);

    try {
      await deleteRunMutation({ runId: runToDelete });
      toast.success("Run deleted successfully");
      setRunToDelete(null);
    } catch (error) {
      console.error("Failed to delete run:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete run",
      );
    } finally {
      setDeletingRunId(null);
    }
  }, [runToDelete, deletingRunId, deleteRunMutation]);

  // Handle create test case - creates directly without modal
  const handleCreateTestCase = useCallback(
    async (suiteId: string) => {
      if (isCreatingTestCase) return;

      setIsCreatingTestCase(true);

      try {
        // Get test cases for the suite to extract models
        const testCases = await convex.query(
          "testSuites:listTestCases" as any,
          { suiteId },
        );

        // Extract unique models from existing test cases
        let modelsToUse: any[] = [];
        if (testCases && Array.isArray(testCases) && testCases.length > 0) {
          const uniqueModels = new Map<
            string,
            { model: string; provider: string }
          >();

          for (const testCase of testCases) {
            if (testCase.models && Array.isArray(testCase.models)) {
              for (const modelConfig of testCase.models) {
                if (modelConfig.model && modelConfig.provider) {
                  const key = `${modelConfig.provider}:${modelConfig.model}`;
                  if (!uniqueModels.has(key)) {
                    uniqueModels.set(key, {
                      model: modelConfig.model,
                      provider: modelConfig.provider,
                    });
                  }
                }
              }
            }
          }

          modelsToUse = Array.from(uniqueModels.values());
        }

        const testCaseId = await createTestCaseMutation({
          suiteId: suiteId,
          title: "Untitled test case",
          query: "",
          models: modelsToUse, // Copy models from suite configuration
        });

        toast.success("Test case created");

        // Track test case created
        posthog.capture("eval_test_case_created", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suiteId,
          test_case_id: testCaseId,
          num_models: modelsToUse.length,
        });

        // Ensure suite is expanded
        setExpandedSuites((prev) => new Set(prev).add(suiteId));

        // Navigate to the new test case
        navigateToEvalsRoute({
          type: "test-detail",
          suiteId,
          testId: testCaseId,
        });
      } catch (error) {
        console.error("Failed to create test case:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to create test case",
        );
      } finally {
        setIsCreatingTestCase(false);
      }
    },
    [
      isCreatingTestCase,
      createTestCaseMutation,
      selectedSuiteId,
      suiteOverview,
    ],
  );

  // Handle delete test case - opens confirmation modal
  const handleDeleteTestCase = useCallback(
    (testCaseId: string, testCaseTitle: string) => {
      if (deletingTestCaseId) return;
      setTestCaseToDelete({ id: testCaseId, title: testCaseTitle });
    },
    [deletingTestCaseId],
  );

  // Confirm test case deletion
  const confirmDeleteTestCase = useCallback(async () => {
    if (!testCaseToDelete || deletingTestCaseId) return;

    setDeletingTestCaseId(testCaseToDelete.id);

    try {
      await deleteTestCaseMutation({ testCaseId: testCaseToDelete.id });
      toast.success("Test case deleted successfully");

      // If we're viewing this test case, navigate back to suite overview
      if (selectedTestId === testCaseToDelete.id && selectedSuiteId) {
        navigateToEvalsRoute({
          type: "suite-overview",
          suiteId: selectedSuiteId,
        });
      }

      setTestCaseToDelete(null);
    } catch (error) {
      console.error("Failed to delete test case:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete test case",
      );
    } finally {
      setDeletingTestCaseId(null);
    }
  }, [
    testCaseToDelete,
    deletingTestCaseId,
    deleteTestCaseMutation,
    selectedTestId,
    selectedSuiteId,
  ]);

  // Duplicate test case handler
  const handleDuplicateTestCase = useCallback(
    async (testCaseId: string, suiteId: string) => {
      if (duplicatingTestCaseId) return;

      setDuplicatingTestCaseId(testCaseId);

      try {
        const newTestCase = await duplicateTestCaseMutation({ testCaseId });
        toast.success("Test case duplicated successfully");

        // Track test case duplicated
        if (newTestCase && newTestCase._id) {
          posthog.capture("eval_test_case_duplicated", {
            location: "evals_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            suite_id: suiteId,
            original_test_case_id: testCaseId,
            new_test_case_id: newTestCase._id,
          });
        }

        // Ensure the suite is expanded to show the new test case
        setExpandedSuites((prev) => new Set(prev).add(suiteId));

        // Navigate to the new duplicated test case
        if (newTestCase && newTestCase._id) {
          navigateToEvalsRoute({
            type: "test-edit",
            suiteId,
            testId: newTestCase._id,
          });
        }
      } catch (error) {
        console.error("Failed to duplicate test case:", error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to duplicate test case",
        );
      } finally {
        setDuplicatingTestCaseId(null);
      }
    },
    [duplicatingTestCaseId, duplicateTestCaseMutation],
  );

  // Handle eval run success - navigate back to list view
  const handleEvalRunSuccess = useCallback(() => {
    navigateToEvalsRoute({ type: "list" });
  }, []);

  // Sort suites for sidebar - MUST be before any early returns
  const sortedSuites = useMemo(() => {
    if (!suiteOverview) return [];
    return [...suiteOverview].sort((a, b) => {
      const aTime =
        a.suite.updatedAt ??
        a.latestRun?.completedAt ??
        a.latestRun?.createdAt ??
        a.suite._creationTime ??
        0;
      const bTime =
        b.suite.updatedAt ??
        b.latestRun?.completedAt ??
        b.latestRun?.createdAt ??
        b.suite._creationTime ??
        0;
      return bTime - aTime;
    });
  }, [suiteOverview]);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="p-6">
        <EmptyState
          icon={FlaskConical}
          title="Sign in to use evals"
          description="Create an account or sign in to run evaluations and view results."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  if (isOverviewLoading && enableOverviewQuery && route.type !== "create") {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">
              Loading your eval data...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {route.type === "create" ? (
        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-6">
          <EvalRunner
            availableModels={availableModels}
            inline={true}
            onSuccess={handleEvalRunSuccess}
          />
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar */}
          <div className="w-64 shrink-0 border-r bg-muted/30 flex flex-col">
            {/* Header */}
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-sm font-semibold">Testsuites</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  posthog.capture("create_new_run_button_clicked", {
                    location: "evals_tab",
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
                        onToggleExpanded={toggleSuiteExpanded}
                        onRerun={handleRerun}
                        onCancelRun={handleCancelRun}
                        onDelete={handleDelete}
                        onDuplicate={handleDuplicateSuite}
                        onCreateTestCase={handleCreateTestCase}
                        onDeleteTestCase={handleDeleteTestCase}
                        onDuplicateTestCase={handleDuplicateTestCase}
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
          </div>

          {/* Main Content Area */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {!selectedSuiteId ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md mx-auto p-8">
                  <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                    <FlaskConical className="h-10 w-10 text-muted-foreground" />
                  </div>
                  <h2 className="text-2xl font-semibold text-foreground mb-2">
                    Select a test suite
                  </h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    Choose a test suite from the sidebar to view its runs, test
                    cases, and performance metrics.
                  </p>
                  {sortedSuites.length === 0 && (
                    <Button
                      onClick={() => {
                        posthog.capture("create_new_run_button_clicked", {
                          location: "evals_tab",
                          platform: detectPlatform(),
                          environment: detectEnvironment(),
                        });
                        navigateToEvalsRoute({ type: "create" });
                      }}
                      className="gap-2"
                      size="sm"
                    >
                      <Plus className="h-4 w-4" />
                      Create your first test suite
                    </Button>
                  )}
                </div>
              </div>
            ) : isSuiteDetailsLoading ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                  <p className="mt-4 text-muted-foreground">
                    Loading suite details...
                  </p>
                </div>
              </div>
            ) : selectedSuite ? (
              <div className="flex-1 overflow-y-auto px-6 pb-6 pt-6">
                <SuiteIterationsView
                  suite={selectedSuite}
                  cases={suiteDetails?.testCases || []}
                  iterations={activeIterations}
                  allIterations={sortedIterations}
                  runs={runsForSelectedSuite}
                  runsLoading={isSuiteRunsLoading}
                  aggregate={suiteAggregate}
                  onRerun={handleRerun}
                  onCancelRun={handleCancelRun}
                  onDelete={handleDelete}
                  onDeleteRun={handleDeleteRun}
                  onDirectDeleteRun={directDeleteRun}
                  connectedServerNames={connectedServerNames}
                  rerunningSuiteId={rerunningSuiteId}
                  cancellingRunId={cancellingRunId}
                  deletingSuiteId={deletingSuiteId}
                  deletingRunId={deletingRunId}
                  availableModels={availableModels}
                  route={route}
                />
              </div>
            ) : selectedSuiteId && !isSuiteDetailsLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md mx-auto p-8">
                  <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                    <AlertTriangle className="h-10 w-10 text-muted-foreground" />
                  </div>
                  <h2 className="text-2xl font-semibold text-foreground mb-2">
                    Suite not found
                  </h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    The test suite you're looking for doesn't exist or may have
                    been deleted.
                  </p>
                  <Button
                    onClick={() => navigateToEvalsRoute({ type: "list" })}
                    variant="outline"
                    size="sm"
                  >
                    Back to test suites
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Delete Suite Confirmation Modal */}
      <Dialog
        open={!!suiteToDelete}
        onOpenChange={(open) => !open && setSuiteToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Test Suite
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the test suite{" "}
              <span className="font-semibold">
                "{suiteToDelete?.name || "Untitled suite"}"
              </span>
              ?
              <br />
              <br />
              This will permanently delete all test cases, runs, and iterations
              associated with this suite. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSuiteToDelete(null)}
              disabled={!!deletingSuiteId}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={!!deletingSuiteId}
            >
              {deletingSuiteId ? "Deleting..." : "Delete Suite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Run Confirmation Modal */}
      <Dialog
        open={!!runToDelete}
        onOpenChange={(open) => !open && setRunToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Run
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this run?
              <br />
              <br />
              This will permanently delete all iterations and results associated
              with this run. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRunToDelete(null)}
              disabled={!!deletingRunId}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteRun}
              disabled={!!deletingRunId}
            >
              {deletingRunId ? "Deleting..." : "Delete Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Test Case Confirmation Modal */}
      <Dialog
        open={!!testCaseToDelete}
        onOpenChange={(open) => !open && setTestCaseToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Test Case
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the test case{" "}
              <span className="font-semibold">
                "{testCaseToDelete?.title || "Untitled test case"}"
              </span>
              ?
              <br />
              <br />
              This will permanently delete all iterations and results associated
              with this test case. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTestCaseToDelete(null)}
              disabled={!!deletingTestCaseId}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteTestCase}
              disabled={!!deletingTestCaseId}
            >
              {deletingTestCaseId ? "Deleting..." : "Delete Test Case"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
