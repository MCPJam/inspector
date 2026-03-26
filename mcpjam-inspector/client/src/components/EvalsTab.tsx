import { useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { FlaskConical } from "lucide-react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useEvalsRoute, navigateToEvalsRoute } from "@/lib/evals-router";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";
import { aggregateSuite } from "./evals/helpers";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { EvalRunner } from "./evals/eval-runner";
import { TestCaseListSidebar } from "./evals/TestCaseListSidebar";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { useSharedAppState } from "@/state/app-state-context";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";

interface EvalsTabProps {
  selectedServer?: string;
  workspaceId?: string | null;
}

export function EvalsTab({ selectedServer, workspaceId }: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  // Use route-based navigation
  const route = useEvalsRoute();

  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;

  // Only highlight test in sidebar when editing (not when viewing history)
  const selectedTestIdForSidebar =
    route.type === "test-edit" ? route.testId : null;

  // Get available models for eval runner
  const { availableModels } = useAvailableEvalModels();

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

  // Get workspace members for the "Run by" column
  const { members } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: workspaceId ?? null,
  });

  const userMap = useMemo(() => {
    if (!members) return undefined;
    const map = new Map<string, { name: string; imageUrl?: string }>();
    for (const m of members) {
      if (m.userId && m.user) {
        map.set(m.userId, {
          name: m.user.name,
          imageUrl: m.user.imageUrl,
        });
      }
    }
    return map;
  }, [members]);

  // Initialize mutations
  const mutations = useEvalMutations();

  // First query to get overview (sortedSuites) - doesn't need specific suite selected
  const overviewQueries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(workspaceId),
    user: workspaceId ? user : null,
    selectedSuiteId: null,
    deletingSuiteId: null,
    workspaceId: workspaceId ?? null,
    organizationId: null,
  });

  const manualSuiteEntries = useMemo(
    () =>
      overviewQueries.sortedSuites.filter(
        (entry) => entry.suite.source !== "sdk",
      ),
    [overviewQueries.sortedSuites],
  );

  // Check if selected server is valid and connected
  const isServerConnected =
    selectedServer &&
    selectedServer !== "none" &&
    appState.servers[selectedServer]?.connectionStatus === "connected";

  // Find suite for selected server from overview
  const serverSuiteEntry = useMemo(() => {
    if (!isServerConnected) return null;
    return manualSuiteEntries.find(
      (entry) => entry.suite.environment?.servers?.[0] === selectedServer,
    );
  }, [manualSuiteEntries, selectedServer, isServerConnected]);

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
    isAuthenticated: isAuthenticated && Boolean(workspaceId),
    user: workspaceId ? user : null,
    selectedSuiteId: serverSuiteId,
    deletingSuiteId: handlers.deletingSuiteId,
    workspaceId: workspaceId ?? null,
    organizationId: null,
  });

  // Use queries for rendering
  const {
    selectedSuite,
    suiteDetails,
    sortedIterations,
    runsForSelectedSuite,
    activeIterations,
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
      if (!workspaceId) {
        toast.error("Select a workspace before creating eval suites.");
        return;
      }
      try {
        const newSuite = await mutations.createTestSuiteMutation({
          workspaceId,
          name: selectedServer,
          description: `Test suite for ${selectedServer}`,
          environment: { servers: [selectedServer] },
        });
        suiteId = newSuite?._id;
      } catch (err) {
        console.error("Failed to create suite:", err);
        toast.error(getBillingErrorMessage(err, "Failed to create test case."));
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
    workspaceId,
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
      if (!workspaceId) {
        toast.error("Select a workspace before creating eval suites.");
        return;
      }
      try {
        const newSuite = await mutations.createTestSuiteMutation({
          workspaceId,
          name: selectedServer,
          description: `Test suite for ${selectedServer}`,
          environment: { servers: [selectedServer] },
        });
        suiteId = newSuite?._id;
      } catch (err) {
        console.error("Failed to create suite:", err);
        toast.error(getBillingErrorMessage(err, "Failed to generate tests."));
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
    workspaceId,
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

  if (!workspaceId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={FlaskConical}
          title="Select a workspace"
          description="Choose a workspace before creating or viewing workspace-bound eval suites."
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
            workspaceId={workspaceId}
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
            defaultSize={30}
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
              selectedServer={selectedServer}
              suite={selectedSuite}
              onRerun={handlers.handleRerun}
              rerunningSuiteId={handlers.rerunningSuiteId}
              connectedServerNames={connectedServerNames}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Main Content Area */}
          <ResizablePanel
            defaultSize={70}
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
                  userMap={userMap}
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
