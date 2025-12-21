import { useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { FlaskConical, Plus, AlertTriangle } from "lucide-react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useEvalsRoute, navigateToEvalsRoute } from "@/lib/evals-router";
import { useChat } from "@/hooks/use-chat";
import { aggregateSuite } from "./evals/helpers";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { EvalRunner } from "./evals/eval-runner";
import { TestCaseListSidebar } from "./evals/TestCaseListSidebar";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { useSharedAppState } from "@/state/app-state-context";

interface EvalsTabProps {
  selectedServer?: string;
}

export function EvalsTab({ selectedServer }: EvalsTabProps) {
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

  // Get available models for eval runner
  const { availableModels } = useChat({
    systemPrompt: "",
    temperature: 1,
    selectedServers: [],
  });

  // Get app state for server connections
  const appState = useSharedAppState();

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

  // First query to get overview (sortedSuites) - doesn't need specific suite selected
  const overviewQueries = useEvalQueries({
    isAuthenticated,
    user,
    selectedSuiteId: null,
    deletingSuiteId: null,
  });

  // Check if selected server is valid and connected
  const isServerConnected =
    selectedServer &&
    selectedServer !== "none" &&
    appState.servers[selectedServer]?.connectionStatus === "connected";

  // Find suite for selected server from overview
  const serverSuiteEntry = useMemo(() => {
    if (!isServerConnected) return null;
    return overviewQueries.sortedSuites.find(
      (entry) => entry.suite.environment?.servers?.[0] === selectedServer,
    );
  }, [overviewQueries.sortedSuites, selectedServer, isServerConnected]);

  const serverSuite = serverSuiteEntry?.suite ?? null;
  const serverSuiteId = serverSuite?._id ?? null;

  // Initialize handlers with server suite
  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry: serverSuiteEntry ?? null,
    selectedSuiteId: serverSuiteId,
    selectedTestId,
  });

  // Main queries with serverSuiteId for details
  const queriesWithDeleteState = useEvalQueries({
    isAuthenticated,
    user,
    selectedSuiteId: serverSuiteId,
    deletingSuiteId: handlers.deletingSuiteId,
  });

  // Use queries for rendering
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

  // Handle eval run success - navigate to suite overview
  const handleEvalRunSuccess = useCallback((suiteId?: string) => {
    if (suiteId) {
      navigateToEvalsRoute({ type: "suite-overview", suiteId });
    } else {
      navigateToEvalsRoute({ type: "list" });
    }
  }, []);

  // Handle creating test case for current server's suite (creates suite if needed)
  const handleCreateTestCase = useCallback(async () => {
    let suiteId = serverSuiteId;

    // Create suite if it doesn't exist
    if (!suiteId && selectedServer && isServerConnected) {
      try {
        const newSuite = await mutations.createTestSuiteMutation({
          name: selectedServer,
          description: `Test suite for ${selectedServer}`,
          environment: { servers: [selectedServer] },
        });
        suiteId = newSuite?._id;
      } catch (err) {
        console.error("Failed to create suite:", err);
        toast.error("Failed to create test case. Please try again.");
        return;
      }
    }

    if (suiteId) {
      await handlers.handleCreateTestCase(suiteId);
    }
  }, [
    serverSuiteId,
    selectedServer,
    isServerConnected,
    mutations.createTestSuiteMutation,
    handlers.handleCreateTestCase,
  ]);

  // Handle duplicate test case
  const handleDuplicateTestCase = useCallback(
    (testCaseId: string) => {
      if (serverSuiteId) {
        handlers.handleDuplicateTestCase(testCaseId, serverSuiteId);
      }
    },
    [serverSuiteId, handlers.handleDuplicateTestCase],
  );

  // Handle generate tests for current server's suite (creates suite if needed)
  const handleGenerateTests = useCallback(async () => {
    if (!selectedServer || !isServerConnected) return;

    let suiteId = serverSuiteId;

    // Create suite if it doesn't exist
    if (!suiteId) {
      try {
        const newSuite = await mutations.createTestSuiteMutation({
          name: selectedServer,
          description: `Test suite for ${selectedServer}`,
          environment: { servers: [selectedServer] },
        });
        suiteId = newSuite?._id;
      } catch (err) {
        console.error("Failed to create suite:", err);
        toast.error("Failed to generate tests. Please try again.");
        return;
      }
    }

    if (suiteId) {
      await handlers.handleGenerateTests(suiteId, [selectedServer]);
    }
  }, [
    serverSuiteId,
    selectedServer,
    isServerConnected,
    mutations.createTestSuiteMutation,
    handlers.handleGenerateTests,
  ]);

  // Loading state
  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
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
        <div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
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
            preselectedServer={selectedServer}
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
            <TestCaseListSidebar
              testCases={suiteDetails?.testCases || []}
              suiteId={serverSuiteId}
              selectedTestId={selectedTestIdForSidebar}
              isLoading={isSuiteDetailsLoading}
              onCreateTestCase={handleCreateTestCase}
              onDeleteTestCase={handlers.handleDeleteTestCase}
              onDuplicateTestCase={handleDuplicateTestCase}
              onGenerateTests={handleGenerateTests}
              deletingTestCaseId={handlers.deletingTestCaseId}
              duplicatingTestCaseId={handlers.duplicatingTestCaseId}
              isGeneratingTests={handlers.isGeneratingTests}
              showingOverview={
                !selectedTestIdForSidebar && serverSuiteId !== null
              }
              noServerSelected={!isServerConnected}
              suite={selectedSuite}
              onRerun={handlers.handleRerun}
              rerunningSuiteId={handlers.rerunningSuiteId}
              connectedServerNames={connectedServerNames}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Main Content Area */}
          <ResizablePanel
            defaultSize={80}
            className="flex flex-col overflow-hidden"
          >
            {!isServerConnected ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md mx-auto p-8">
                  <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                    <FlaskConical className="h-10 w-10 text-muted-foreground" />
                  </div>
                  <h2 className="text-2xl font-semibold text-foreground mb-2">
                    Select a server
                  </h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    Choose a server from the tabs above to view and manage its
                    test cases.
                  </p>
                </div>
              </div>
            ) : !serverSuite ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md mx-auto p-8">
                  <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                    <FlaskConical className="h-10 w-10 text-muted-foreground" />
                  </div>
                  <h2 className="text-2xl font-semibold text-foreground mb-2">
                    No test cases yet
                  </h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    Create your first test case for "{selectedServer}" to start
                    evaluating your MCP server.
                  </p>
                </div>
              </div>
            ) : isSuiteDetailsLoading ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                  <p className="mt-4 text-muted-foreground">
                    Loading test cases...
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
