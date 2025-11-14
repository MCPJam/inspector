import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { FlaskConical, Plus, AlertTriangle, ChevronDown, ChevronRight, MoreVertical, RotateCw, Trash2, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { useTemplateGroups } from "./evals/use-template-groups";

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
  onRerun,
  onCancelRun,
  onDelete,
  isRerunning,
  isCancelling,
  isDeleting,
  connectedServerNames,
}: {
  suite: EvalSuite;
  latestRun: EvalSuiteRun | null | undefined;
  isSelected: boolean;
  isExpanded: boolean;
  selectedTestId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onToggleExpanded: (suiteId: string) => void;
  onSelectTest: (testId: string | null) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onDelete: (suite: EvalSuite) => void;
  isRerunning: boolean;
  isCancelling: boolean;
  isDeleting: boolean;
  connectedServerNames: Set<string>;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();

  // Load suite details only when expanded
  const enableSuiteDetailsQuery = isAuthenticated && !!user && isExpanded;
  const suiteDetails = useQuery(
    "evals:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: suite._id } as any) : "skip",
  ) as SuiteDetailsQueryResponse | undefined;

  // Compute template groups from suite config (not just from iterations)
  const templateGroupsFromConfig = useMemo(() => {
    const tests = suite.config?.tests || [];
    if (tests.length === 0) return [];

    // Extract templates by de-duplicating (remove model suffix from title)
    const templateMap = new Map<string, { title: string; query: string; testCaseIds: string[]; templateKey: string }>();
    tests.forEach((test: any) => {
      // Remove model suffix like " [ModelName]" from title
      const templateTitle = test.title.replace(/\s*\[.*?\]\s*$/, '').trim();
      const key = `${templateTitle}-${test.query}`;

      if (!templateMap.has(key)) {
        templateMap.set(key, {
          title: templateTitle,
          query: test.query,
          testCaseIds: [],
          templateKey: `template:${key}`, // Synthetic key for templates without testCaseIds
        });
      }

      // Add testCaseId if available
      if (test.testCaseId) {
        templateMap.get(key)!.testCaseIds.push(test.testCaseId);
      }
    });

    return Array.from(templateMap.values());
  }, [suite.config?.tests]);

  // Also get template groups from iterations (for cases where we have run data)
  const { templateGroups: templateGroupsFromIterations } = useTemplateGroups(suiteDetails, isExpanded);

  // Merge: prefer config templates, but use iteration data if available for testCaseIds
  const templateGroups = useMemo(() => {
    if (templateGroupsFromConfig.length > 0) {
      // Use config templates as the source of truth
      return templateGroupsFromConfig.map(configTemplate => {
        // Try to find matching iteration template to get testCaseIds
        const iterationTemplate = templateGroupsFromIterations.find(
          it => it.title === configTemplate.title && it.query === configTemplate.query
        );
        return {
          ...configTemplate,
          testCaseIds: iterationTemplate?.testCaseIds || configTemplate.testCaseIds,
          // Preserve templateKey from config
          templateKey: configTemplate.templateKey,
        };
      });
    }
    // Fallback to iteration templates if no config templates
    // Add templateKey for iteration templates that don't have testCaseIds
    return templateGroupsFromIterations.map(tg => ({
      ...tg,
      templateKey: tg.testCaseIds.length === 0 ? `template:${tg.title}-${tg.query}` : undefined,
    }));
  }, [templateGroupsFromConfig, templateGroupsFromIterations]);

  // Check for missing servers
  const suiteServers = suite.config?.environment?.servers || [];
  const missingServers = suiteServers.filter(
    (server) => !connectedServerNames.has(server),
  );
  const hasMissingServers = missingServers.length > 0;

  // Check if there's an active run (pending or running)
  const hasActiveRun = latestRun && (latestRun.status === "pending" || latestRun.status === "running");

  return (
    <div>
      <div
        className={cn(
          "group w-full flex items-center gap-1 px-4 py-2 text-left text-sm transition-colors hover:bg-accent/50",
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
            "flex-1 min-w-0 text-left rounded px-2 py-1 transition-colors",
            isSelected && !selectedTestId && "font-medium"
          )}
        >
          <div className="truncate font-medium">
            {suite.name || "Untitled suite"}
          </div>
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
                <X className={cn(
                  "h-4 w-4 mr-2 text-foreground",
                  isCancelling && "opacity-50"
                )} />
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
                      <RotateCw className={cn(
                        "h-4 w-4 mr-2 text-foreground",
                        (hasMissingServers || isRerunning) && "opacity-50",
                        isRerunning && "animate-spin"
                      )} />
                      {isRerunning ? "Rerunning..." : "Rerun"}
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
      
      {/* Test Cases Dropdown */}
      {isExpanded && (
        <div className="pb-2">
          {templateGroups.length === 0 ? (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">
              {enableSuiteDetailsQuery && suiteDetails === undefined ? "Loading..." : "No test cases"}
            </div>
          ) : (
            templateGroups.map((group, index) => {
              const hasTestCaseIds = group.testCaseIds.length > 0;
              // Use templateKey as identifier if no testCaseIds, otherwise use first testCaseId
              const groupIdentifier = hasTestCaseIds ? group.testCaseIds[0] : (group as any).templateKey;
              const isTestSelected = selectedTestId && (
                (hasTestCaseIds && group.testCaseIds.includes(selectedTestId)) ||
                (!hasTestCaseIds && selectedTestId === (group as any).templateKey)
              );

              return (
                <button
                  key={index}
                  onClick={() => {
                    // First select the suite if needed
                    if (!isSelected) {
                      onSelectSuite(suite._id);
                    }
                    // Use templateKey if no testCaseIds, otherwise use first testCaseId
                    onSelectTest(groupIdentifier || null);
                  }}
                  className={cn(
                    "w-full flex items-center px-6 py-2 text-left text-xs hover:bg-accent/50 transition-colors",
                    isTestSelected && "bg-accent/70 font-medium"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{group.title}</div>
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
  const cancelRunMutation = useMutation("evals:cancelSuiteRun" as any);

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

  // Filter iterations to only include those from active runs
  const activeIterations = useMemo(() => {
    if (!suiteRuns || sortedIterations.length === 0) return sortedIterations;
    
    const activeRunIds = new Set(
      suiteRuns.filter((run) => run.isActive !== false).map((run) => run._id)
    );
    
    return sortedIterations.filter((iteration) => 
      !iteration.suiteRunId || activeRunIds.has(iteration.suiteRunId)
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
                          // Clear test selection when clicking on suite name
                          setSelectedTestId(null);
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
                        onRerun={handleRerun}
                        onCancelRun={handleCancelRun}
                        onDelete={handleDelete}
                        isRerunning={rerunningSuiteId === suite._id}
                        isCancelling={cancellingRunId === latestRun?._id}
                        isDeleting={deletingSuiteId === suite._id}
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
                    Choose a test suite from the sidebar to view its runs, test cases, and performance metrics.
                  </p>
                  {sortedSuites.length === 0 && (
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
