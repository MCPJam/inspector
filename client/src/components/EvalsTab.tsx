import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { FlaskConical, Plus, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
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
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
  SuiteDetailsQueryResponse,
} from "./evals/types";
import { aggregateSuite } from "./evals/helpers";
import { SuitesOverview } from "./evals/suites-overview";
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
import { useTemplateGroups, useTemplateGroupsCount } from "./evals/use-template-groups";

// Component to render a single suite in the sidebar with its own data loading
function SuiteSidebarItem({
  suite,
  latestRun,
  isSelected,
  isExpanded,
  selectedTestId,
  onSelectSuite,
  onToggleExpanded,
  onSelectTest,
}: {
  suite: EvalSuite;
  latestRun: EvalSuiteRun | null | undefined;
  isSelected: boolean;
  isExpanded: boolean;
  selectedTestId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onToggleExpanded: (suiteId: string) => void;
  onSelectTest: (testId: string) => void;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();

  const latestPassRate = latestRun?.summary
    ? Math.round(latestRun.summary.passRate * 100)
    : 0;

  // Load suite details only when expanded
  const enableSuiteDetailsQuery = isAuthenticated && !!user && isExpanded;
  const suiteDetails = useQuery(
    "evals:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: suite._id } as any) : "skip",
  ) as SuiteDetailsQueryResponse | undefined;

  // Compute unique template groups count from config (for collapsed state)
  const uniqueTemplateGroupsCount = useTemplateGroupsCount(suite.config);

  // Compute template groups for this suite
  const { templateGroups } = useTemplateGroups(suiteDetails, isExpanded);

  return (
    <div>
      <div
        className={cn(
          "w-full flex items-center gap-1 px-4 py-2 text-left text-sm transition-colors",
          isSelected && !selectedTestId && "bg-accent"
        )}
      >
        <button
          onClick={() => onToggleExpanded(suite._id)}
          className="shrink-0 p-1 hover:bg-accent/50 rounded transition-colors"
          aria-label={isExpanded ? "Collapse suite" : "Expand suite"}
        >
          {isExpanded && suiteDetails ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4 opacity-50" />
          )}
        </button>
        <button
          onClick={() => onSelectSuite(suite._id)}
          className={cn(
            "flex-1 min-w-0 text-left hover:bg-accent/50 rounded px-2 py-1 transition-colors",
            isSelected && !selectedTestId && "font-medium"
          )}
        >
          <div className="truncate font-medium">
            {suite.name || "Untitled suite"}
          </div>
          <div className="text-xs text-muted-foreground">
            {latestPassRate}% • {isExpanded && suiteDetails ? templateGroups.length : uniqueTemplateGroupsCount} test{(isExpanded && suiteDetails ? templateGroups.length : uniqueTemplateGroupsCount) === 1 ? "" : "s"}
          </div>
        </button>
      </div>
      
      {/* Test Cases Dropdown */}
      {isExpanded && suiteDetails && (
        <div className="pb-2">
          {templateGroups.length === 0 ? (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">
              {suiteDetails === undefined ? "Loading..." : "No test cases"}
            </div>
          ) : (
            templateGroups.map((group, index) => {
              const passedCount = group.summary.passed;
              const totalCount = group.summary.runs;
              const passRate = totalCount > 0
                ? Math.round((passedCount / totalCount) * 100)
                : 0;
              const isTestSelected = selectedTestId && group.testCaseIds.includes(selectedTestId);

              return (
                <button
                  key={index}
                  onClick={() => {
                    // First select the suite if needed, then the test
                    if (!isSelected) {
                      onSelectSuite(suite._id);
                    }
                    onSelectTest(group.testCaseIds[0]);
                  }}
                  className={cn(
                    "w-full flex items-center justify-between px-6 py-2 text-left text-xs hover:bg-accent/50 transition-colors",
                    isTestSelected && "bg-accent/70 font-medium"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{group.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {group.testCaseIds.length} model{group.testCaseIds.length === 1 ? "" : "s"} • {totalCount} iteration{totalCount === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="ml-2 text-xs font-medium shrink-0">
                    {passRate}%
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

type View = "results" | "run";

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user, getAccessToken } = useAuth();

  const [view, setView] = useState<View>("results");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  const [rerunningSuiteId, setRerunningSuiteId] = useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);

  const [deletingSuiteId, setDeletingSuiteId] = useState<string | null>(null);
  const [suiteToDelete, setSuiteToDelete] = useState<EvalSuite | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set());

  // Reset selectedTestId only when suite changes without a test being explicitly selected
  // We track this by checking if the test selection was intentional
  const pendingTestSelection = useRef<string | null>(null);

  useEffect(() => {
    // Only reset if there's no pending test selection
    if (!pendingTestSelection.current) {
      setSelectedTestId(null);
    } else {
      setSelectedTestId(pendingTestSelection.current);
      pendingTestSelection.current = null;
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

  const deleteSuiteMutation = useMutation("evals:deleteSuite" as any);

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
    "evals:getSuiteOverview" as any,
    enableOverviewQuery ? ({} as any) : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  const enableSuiteDetailsQuery =
    isAuthenticated && !!user && !!selectedSuiteId;
  const suiteDetails = useQuery(
    "evals:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip",
  ) as SuiteDetailsQueryResponse | undefined;

  const suiteRuns = useQuery(
    "evals:getSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 20 } as any)
      : "skip",
  ) as EvalSuiteRun[] | undefined;

  const isOverviewLoading = suiteOverview === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;

  const isSuiteRunsLoading =
    enableSuiteDetailsQuery && suiteRuns === undefined;

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

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      sortedIterations,
    );
  }, [selectedSuite, suiteDetails, sortedIterations]);

  // Rerun handler
  const handleRerun = useCallback(
    async (suite: EvalSuite) => {
      if (rerunningSuiteId) return;

      const suiteServers = suite.config?.environment?.servers || [];
      const missingServers = suiteServers.filter(
        (server) => !connectedServerNames.has(server),
      );

      if (missingServers.length > 0) {
        toast.error(
          `Please connect the following servers first: ${missingServers.join(", ")}`,
        );
        return;
      }

      // Get the tests from the suite config
      const tests = suite.config?.tests || [];
      if (tests.length === 0) {
        toast.error("No tests found in this suite");
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

      try {
        const accessToken = await getAccessToken();

        // Get pass criteria from the latest run, or default to 100%
        const latestRun = selectedSuiteEntry?.latestRun;
        const minimumPassRate = latestRun?.passCriteria?.minimumPassRate ?? 100;
        const criteriaNote = `Pass Criteria: Min ${minimumPassRate}% pass rate`;

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
              judgeRequirement: test.judgeRequirement,
              advancedConfig: test.advancedConfig,
            })),
            serverIds: suiteServers,
            modelApiKeys: Object.keys(modelApiKeys).length > 0 ? modelApiKeys : undefined,
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

        toast.success(
          "Eval run started successfully! Results will appear shortly.",
        );
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
      connectedServerNames,
      selectedSuiteEntry,
      getAccessToken,
      hasToken,
      getToken,
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

      // If we're viewing this suite, go back to the overview
      if (selectedSuiteId === suiteToDelete._id) {
        setSelectedSuiteId(null);
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

  // Cancel handler
  const handleCancelRun = useCallback(
    async (runId: string) => {
      if (cancellingRunId) return;

      setCancellingRunId(runId);

      try {
        const accessToken = await getAccessToken();

        const response = await fetch("/api/mcp/evals/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            convexAuthToken: accessToken,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to cancel run");
        }

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
    [cancellingRunId, getAccessToken],
  );

  // Handle eval run success - navigate back to results view
  const handleEvalRunSuccess = useCallback(() => {
    setView("results");
    setSelectedSuiteId(null);
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

  if (isOverviewLoading && enableOverviewQuery && view === "results") {
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
      {view === "run" ? (
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
              <h2 className="text-sm font-semibold">Test Suites</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  posthog.capture("create_new_run_button_clicked", {
                    location: "evals_tab",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                  });
                  setView("run");
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
                        selectedTestId={selectedTestId}
                        onSelectSuite={(suiteId) => {
                          // Only clear pending test when explicitly clicking the suite (not via test selection)
                          pendingTestSelection.current = null;
                          setSelectedSuiteId(suiteId);
                          if (selectedSuiteId !== suiteId) {
                            // Auto-expand when selecting a new suite
                            setExpandedSuites((prev) => new Set(prev).add(suiteId));
                          }
                        }}
                        onToggleExpanded={toggleSuiteExpanded}
                        onSelectTest={(testId) => {
                          // Store the test ID to be selected after suite changes
                          pendingTestSelection.current = testId;
                          setSelectedTestId(testId);
                        }}
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
              <>
                <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b">
                  <h1 className="text-2xl font-semibold">Test suites</h1>
                  <Button
                    onClick={() => {
                      posthog.capture("create_new_run_button_clicked", {
                        location: "evals_tab",
                        platform: detectPlatform(),
                        environment: detectEnvironment(),
                      });
                      setView("run");
                    }}
                    className="gap-2"
                    size="sm"
                  >
                    <Plus className="h-4 w-4" />
                    Create new test suite
                  </Button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 pb-6 pt-6">
                  <SuitesOverview
                    overview={suiteOverview || []}
                    onSelectSuite={setSelectedSuiteId}
                    onRerun={handleRerun}
                    onCancelRun={handleCancelRun}
                    onDelete={handleDelete}
                    connectedServerNames={connectedServerNames}
                    rerunningSuiteId={rerunningSuiteId}
                    cancellingRunId={cancellingRunId}
                    deletingSuiteId={deletingSuiteId}
                  />
                </div>
              </>
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
                  iterations={sortedIterations}
                  allIterations={sortedIterations}
                  runs={runsForSelectedSuite}
                  runsLoading={isSuiteRunsLoading}
                  aggregate={suiteAggregate}
                  onBack={() => setSelectedSuiteId(null)}
                  onRerun={handleRerun}
                  onCancelRun={handleCancelRun}
                  onDelete={handleDelete}
                  connectedServerNames={connectedServerNames}
                  rerunningSuiteId={rerunningSuiteId}
                  cancellingRunId={cancellingRunId}
                  deletingSuiteId={deletingSuiteId}
                  availableModels={availableModels}
                  selectedTestId={selectedTestId}
                  onTestIdChange={setSelectedTestId}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}


      {/* Delete Confirmation Modal */}
      <Dialog open={!!suiteToDelete} onOpenChange={(open) => !open && setSuiteToDelete(null)}>
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
    </div>
  );
}
