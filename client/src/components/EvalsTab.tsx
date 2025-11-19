import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { FlaskConical, Plus, AlertTriangle } from "lucide-react";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { useEvalsRoute, navigateToEvalsRoute } from "@/lib/evals-router";
import { useChat } from "@/hooks/use-chat";
import { useAppState } from "@/hooks/use-app-state";
import { aggregateSuite } from "./evals/helpers";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { EvalRunner } from "./evals/eval-runner";
import { SuiteListSidebar } from "./evals/SuiteListSidebar";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  // Use route-based navigation
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

  // Track expanded suites
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

  // Get available models for eval runner
  const { availableModels } = useChat({
    systemPrompt: "",
    temperature: 1,
    selectedServers: [],
  });

  // Get app state for server connections
  const { appState } = useAppState();

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

  // Initialize mutations
  const mutations = useEvalMutations();

  // Initialize queries
  const queries = useEvalQueries({
    isAuthenticated,
    user,
    selectedSuiteId,
    deletingSuiteId: null, // We'll get this from handlers
  });

  // Initialize handlers
  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry: queries.selectedSuiteEntry,
    selectedSuiteId,
    selectedTestId,
  });

  // Update queries with deletingSuiteId from handlers
  const queriesWithDeleteState = useEvalQueries({
    isAuthenticated,
    user,
    selectedSuiteId,
    deletingSuiteId: handlers.deletingSuiteId,
  });

  // Use final queries with delete state
  const {
    selectedSuite,
    suiteDetails,
    sortedIterations,
    runsForSelectedSuite,
    activeIterations,
    sortedSuites,
    isOverviewLoading,
    isSuiteDetailsLoading,
    isSuiteRunsLoading,
    enableOverviewQuery,
  } = queriesWithDeleteState;

  // Track page view
  useEffect(() => {
    posthog.capture("evals_tab_viewed", {
      location: "evals_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

  // Compute suite aggregate
  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      activeIterations,
    );
  }, [selectedSuite, suiteDetails, activeIterations]);

  // Handle eval run success - navigate back to list view
  const handleEvalRunSuccess = useCallback(() => {
    navigateToEvalsRoute({ type: "list" });
  }, []);

  // Handle creating test case with suite expansion
  const handleCreateTestCaseWithExpansion = useCallback(
    async (suiteId: string) => {
      const testCaseId = await handlers.handleCreateTestCase(suiteId);
      if (testCaseId) {
        // Ensure suite is expanded
        setExpandedSuites((prev) => new Set(prev).add(suiteId));
      }
    },
    [handlers.handleCreateTestCase],
  );

  // Loading state
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

  // Not authenticated
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

  // Loading overview
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
        <ResizablePanelGroup
          direction="horizontal"
          className="flex-1 overflow-hidden"
        >
          {/* Left Sidebar */}
          <ResizablePanel
            defaultSize={20}
            minSize={15}
            maxSize={40}
            className="border-r bg-muted/30 flex flex-col"
          >
            <SuiteListSidebar
              sortedSuites={sortedSuites}
              isOverviewLoading={isOverviewLoading}
              selectedSuiteId={selectedSuiteId}
              selectedTestIdForSidebar={selectedTestIdForSidebar}
              expandedSuites={expandedSuites}
              onToggleSuiteExpanded={toggleSuiteExpanded}
              onRerun={handlers.handleRerun}
              onCancelRun={handlers.handleCancelRun}
              onDelete={handlers.handleDelete}
              onDuplicate={handlers.handleDuplicateSuite}
              onCreateTestCase={handleCreateTestCaseWithExpansion}
              onDeleteTestCase={handlers.handleDeleteTestCase}
              onDuplicateTestCase={handlers.handleDuplicateTestCase}
              rerunningSuiteId={handlers.rerunningSuiteId}
              cancellingRunId={handlers.cancellingRunId}
              deletingSuiteId={handlers.deletingSuiteId}
              duplicatingSuiteId={handlers.duplicatingSuiteId}
              deletingTestCaseId={handlers.deletingTestCaseId}
              duplicatingTestCaseId={handlers.duplicatingTestCaseId}
              connectedServerNames={connectedServerNames}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Main Content Area */}
          <ResizablePanel
            defaultSize={80}
            className="flex flex-col overflow-hidden"
          >
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
                  onRerun={handlers.handleRerun}
                  onCancelRun={handlers.handleCancelRun}
                  onDelete={handlers.handleDelete}
                  onDeleteRun={handlers.handleDeleteRun}
                  onDirectDeleteRun={handlers.directDeleteRun}
                  connectedServerNames={connectedServerNames}
                  rerunningSuiteId={handlers.rerunningSuiteId}
                  cancellingRunId={handlers.cancellingRunId}
                  deletingSuiteId={handlers.deletingSuiteId}
                  deletingRunId={handlers.deletingRunId}
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
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {/* Confirmation Dialogs */}
      <ConfirmationDialogs
        suiteToDelete={handlers.suiteToDelete}
        setSuiteToDelete={handlers.setSuiteToDelete}
        deletingSuiteId={handlers.deletingSuiteId}
        onConfirmDeleteSuite={handlers.confirmDelete}
        runToDelete={handlers.runToDelete}
        setRunToDelete={handlers.setRunToDelete}
        deletingRunId={handlers.deletingRunId}
        onConfirmDeleteRun={handlers.confirmDeleteRun}
        testCaseToDelete={handlers.testCaseToDelete}
        setTestCaseToDelete={handlers.setTestCaseToDelete}
        deletingTestCaseId={handlers.deletingTestCaseId}
        onConfirmDeleteTestCase={handlers.confirmDeleteTestCase}
      />
    </div>
  );
}
