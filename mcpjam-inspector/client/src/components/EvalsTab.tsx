import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useMutation } from "convex/react";
import { FlaskConical, Loader2 } from "lucide-react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { buildEvalsHash, useEvalsRoute } from "@/lib/evals-router";
import { withTestingSurface } from "@/lib/testing-surface";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";
import { aggregateSuite } from "./evals/helpers";
import {
  SuiteIterationsView,
  type SuiteNavigation,
} from "./evals/suite-iterations-view";
import { TestCaseListSidebar } from "./evals/TestCaseListSidebar";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { useSharedAppState } from "@/state/app-state-context";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { exportServerApi } from "@/lib/apis/mcp-export-api";
import {
  generateAgentBrief,
  mapEvalCasesToAgentBriefExploreCases,
} from "@/lib/generate-agent-brief";
import { getServerUrl } from "@/components/connection/server-card-utils";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { EvalCase } from "./evals/types";
import { EXPLORE_SUITE_TAG, isExploreSuite } from "./evals/constants";

interface EvalsTabProps {
  selectedServer?: string;
  workspaceId?: string | null;
}

const EMPTY_CASES: EvalCase[] = [];

export function EvalsTab({ selectedServer, workspaceId }: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const route = useEvalsRoute();
  const appState = useSharedAppState();
  const { availableModels } = useAvailableEvalModels();
  const updateSuiteMutation = useMutation("testSuites:updateTestSuite" as any);
  const mutations = useEvalMutations();

  const [isPreparingExplore, setIsPreparingExplore] = useState(false);
  const [isCopyingExploreSdkBrief, setIsCopyingExploreSdkBrief] =
    useState(false);
  const initializedExploreRef = useRef<Set<string>>(new Set());

  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;
  const connectedServerNames = useMemo(
    () =>
      new Set(
        Object.entries(appState.servers)
          .filter(([, server]) => server.connectionStatus === "connected")
          .map(([name]) => name),
      ),
    [appState.servers],
  );

  const isServerConnected =
    selectedServer &&
    selectedServer !== "none" &&
    appState.servers[selectedServer]?.connectionStatus === "connected";

  const { members, canManageMembers } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: workspaceId ?? null,
  });

  const canDeleteRuns = !workspaceId || canManageMembers;

  const userMap = useMemo(() => {
    if (!members) return undefined;
    const map = new Map<string, { name: string; imageUrl?: string }>();
    for (const member of members) {
      if (member.userId && member.user) {
        map.set(member.userId, {
          name: member.user.name,
          imageUrl: member.user.imageUrl,
        });
      }
    }
    return map;
  }, [members]);

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

  const exploreSuiteEntry = useMemo(() => {
    if (!selectedServer || !isServerConnected) return null;
    return (
      manualSuiteEntries.find(
        (entry) =>
          isExploreSuite(entry.suite) &&
          entry.suite.environment?.servers?.[0] === selectedServer,
      ) ?? null
    );
  }, [manualSuiteEntries, selectedServer, isServerConnected]);

  const selectedSuiteId = exploreSuiteEntry?.suite._id ?? null;

  const activeSuiteEntry = exploreSuiteEntry;

  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry: activeSuiteEntry,
    selectedSuiteId,
    selectedTestId,
    workspaceId: workspaceId ?? null,
    connectedServerNames,
  });

  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(workspaceId),
    user: workspaceId ? user : null,
    selectedSuiteId,
    deletingSuiteId: handlers.deletingSuiteId,
    workspaceId: workspaceId ?? null,
    organizationId: null,
  });

  const selectedSuite = queries.selectedSuite;
  const suiteDetails = queries.suiteDetails;
  const activeIterations = queries.activeIterations;
  const sortedIterations = queries.sortedIterations;
  const runsForSelectedSuite = queries.runsForSelectedSuite;

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      activeIterations,
    );
  }, [selectedSuite, suiteDetails, activeIterations]);
  const latestRunForSidebar = useMemo(() => {
    if (!runsForSelectedSuite.length) return null;
    return [...runsForSelectedSuite].sort((a, b) => {
      const aTime = a.completedAt ?? a.createdAt ?? 0;
      const bTime = b.completedAt ?? b.createdAt ?? 0;
      return bTime - aTime;
    })[0];
  }, [runsForSelectedSuite]);

  const exploreSuite = selectedSuite;
  const exploreCases = suiteDetails?.testCases ?? EMPTY_CASES;

  const handleCopyExploreSdkEvalBrief = useCallback(async () => {
    if (!selectedServer || exploreCases.length === 0) return;
    setIsCopyingExploreSdkBrief(true);
    try {
      const data = await exportServerApi(selectedServer);
      const serverUrl = getServerUrl(
        appState.servers[selectedServer]?.config ?? ({} as MCPServerConfig),
      );
      const exploreTestCases =
        mapEvalCasesToAgentBriefExploreCases(exploreCases);
      const markdown = generateAgentBrief(data, {
        serverUrl,
        exploreTestCases,
      });
      await navigator.clipboard.writeText(markdown);
      toast.success("SDK eval brief copied to clipboard");
      posthog.capture("explore_copy_sdk_eval_brief_clicked", {
        location: "test_case_list_sidebar",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: selectedServer,
        case_count: exploreCases.length,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to copy SDK eval brief: ${errorMessage}`);
    } finally {
      setIsCopyingExploreSdkBrief(false);
    }
  }, [appState.servers, exploreCases, selectedServer]);

  useEffect(() => {
    if (
      !selectedServer ||
      !isServerConnected ||
      !workspaceId ||
      !isAuthenticated
    ) {
      return;
    }
    if (exploreSuiteEntry) {
      return;
    }
    if (initializedExploreRef.current.has(selectedServer)) {
      return;
    }

    initializedExploreRef.current.add(selectedServer);
    setIsPreparingExplore(true);

    void (async () => {
      try {
        const createdSuite = await mutations.createTestSuiteMutation({
          workspaceId,
          name: selectedServer,
          description: `Explore cases for ${selectedServer}`,
          environment: { servers: [selectedServer] },
        });

        if (createdSuite?._id) {
          await updateSuiteMutation({
            suiteId: createdSuite._id,
            tags: [EXPLORE_SUITE_TAG],
          });
        }
      } catch (error) {
        initializedExploreRef.current.delete(selectedServer);
        toast.error(
          getBillingErrorMessage(
            error,
            "Failed to create the Explore workspace",
          ),
        );
      } finally {
        setIsPreparingExplore(false);
      }
    })();
  }, [
    isAuthenticated,
    exploreSuiteEntry,
    isServerConnected,
    mutations.createTestSuiteMutation,
    selectedServer,
    updateSuiteMutation,
    workspaceId,
  ]);

  const exploreNavigation = useMemo((): SuiteNavigation => {
    const toExploreList = () => {
      window.location.hash = withTestingSurface(
        buildEvalsHash({ type: "list" }),
      );
    };
    return {
      toSuiteOverview: (_suiteId, _view) => {
        toExploreList();
      },
      toRunDetail: (suiteId, runId, iteration) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "run-detail", suiteId, runId, iteration }),
        );
      },
      toTestDetail: (suiteId, testId, iteration) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "test-detail", suiteId, testId, iteration }),
        );
      },
      toTestEdit: (suiteId, testId) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "test-edit", suiteId, testId }),
        );
      },
      toSuiteEdit: (suiteId) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "suite-edit", suiteId }),
        );
      },
    };
  }, []);

  const handleGenerateMore = useCallback(async () => {
    if (!exploreSuite || !selectedServer) return;
    await handlers.handleGenerateTests(exploreSuite._id, [selectedServer]);
    await handlers.handleRerun(exploreSuite);
  }, [exploreSuite, handlers, selectedServer]);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">Loading testing...</p>
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
          title="Sign in to use Testing"
          description="Create an account or sign in to explore cases and investigate runs."
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
          description="Choose a workspace before creating or viewing workspace-bound testing suites."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  const showExploreLoading =
    isPreparingExplore ||
    (selectedServer &&
      isServerConnected &&
      !exploreSuite &&
      queries.isOverviewLoading);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!isServerConnected ? (
          <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
            <EmptyState
              icon={FlaskConical}
              title="Connect a server to start exploring"
              description="MCPJam generates explore cases after you connect."
              className="h-auto min-h-[240px]"
            />
          </div>
        ) : showExploreLoading ? (
          <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center px-4 sm:px-6">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">
              Preparing the Explore workspace for {selectedServer}...
            </p>
          </div>
        ) : !exploreSuite ? (
          <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
            <EmptyState
              icon={FlaskConical}
              title="Explore is waiting on a connected server"
              description="Reconnect the server or pick another one from the header to start generating cases."
              className="h-auto min-h-[240px]"
            />
          </div>
        ) : (
          <ResizablePanelGroup
            direction="horizontal"
            className="min-h-0 flex-1"
          >
            <ResizablePanel
              defaultSize={28}
              minSize={18}
              maxSize={40}
              className="flex min-h-0 flex-col border-r bg-muted/30"
            >
              <TestCaseListSidebar
                heading="Cases"
                emptyLabel="No cases yet"
                testCases={exploreCases}
                suiteId={exploreSuite._id}
                selectedTestId={selectedTestId}
                isLoading={queries.isSuiteDetailsLoading}
                onCreateTestCase={async () =>
                  handlers.handleCreateTestCase(exploreSuite._id)
                }
                onDeleteTestCase={handlers.handleDeleteTestCase}
                onDuplicateTestCase={(testCaseId) =>
                  handlers.handleDuplicateTestCase(testCaseId, exploreSuite._id)
                }
                onGenerateTests={() => void handleGenerateMore()}
                onCopySdkEvalBrief={() => void handleCopyExploreSdkEvalBrief()}
                isCopyingSdkEvalBrief={isCopyingExploreSdkBrief}
                deletingTestCaseId={handlers.deletingTestCaseId}
                duplicatingTestCaseId={handlers.duplicatingTestCaseId}
                isGeneratingTests={handlers.isGeneratingTests}
                showingOverview={!selectedTestId}
                noServerSelected={!isServerConnected}
                selectedServer={selectedServer}
                suite={exploreSuite}
                latestRun={latestRunForSidebar}
                onRerun={handlers.handleRerun}
                rerunningSuiteId={handlers.rerunningSuiteId}
                connectedServerNames={connectedServerNames}
                showSelection={false}
                onNavigateToOverview={(suiteId) => {
                  window.location.hash = withTestingSurface(
                    buildEvalsHash({ type: "suite-overview", suiteId }),
                  );
                }}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={72}
              className="flex min-h-0 flex-col overflow-hidden"
            >
              {queries.isSuiteDetailsLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                    <p className="mt-4 text-sm text-muted-foreground">
                      Loading cases...
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-6 pt-4 sm:px-6">
                  <SuiteIterationsView
                    suite={exploreSuite}
                    cases={exploreCases}
                    iterations={activeIterations}
                    allIterations={sortedIterations}
                    runs={runsForSelectedSuite}
                    runsLoading={queries.isSuiteRunsLoading}
                    aggregate={suiteAggregate}
                    caseListInSidebar
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
                    workspaceId={workspaceId}
                    navigation={exploreNavigation}
                    canDeleteRuns={canDeleteRuns}
                  />
                </div>
              )}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>

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
