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
import { useEvalsRoute } from "@/lib/evals-router";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { aggregateSuite } from "./evals/helpers";
import { EvalTabGate } from "./evals/EvalTabGate";
import {
  createPlaygroundSuiteNavigation,
  navigatePlaygroundEvalsRoute,
} from "./evals/create-suite-navigation";
import { RunIterationsSidebar } from "./evals/run-detail-view";
import { useRunDetailData } from "./evals/use-suite-data";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { TestCaseListSidebar } from "./evals/TestCaseListSidebar";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { useSharedAppState } from "@/state/app-state-context";
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
import { getPersistedTestCaseModelValue } from "./evals/single-test-case-runner";

interface EvalsTabProps {
  selectedServer?: string;
  workspaceId?: string | null;
}

const EMPTY_CASES: EvalCase[] = [];

/** Module-level guard so fast tab-switches (unmount/remount) don't duplicate suite creation. */
const globalInitializedExplore = new Set<string>();

export function EvalsTab({ selectedServer, workspaceId }: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const route = useEvalsRoute();
  const appState = useSharedAppState();
  const {
    connectedServerNames,
    userMap,
    canDeleteSuite,
    canDeleteRuns,
    availableModels,
  } = useEvalTabContext({
    isAuthenticated,
    workspaceId: workspaceId ?? null,
  });
  const updateSuiteMutation = useMutation("testSuites:updateTestSuite" as any);
  const mutations = useEvalMutations();

  const [isPreparingExplore, setIsPreparingExplore] = useState(false);
  const [isCopyingExploreSdkBrief, setIsCopyingExploreSdkBrief] =
    useState(false);
  const [runDetailSidebarSortBy, setRunDetailSidebarSortBy] = useState<
    "model" | "test" | "result"
  >("result");
  const playgroundAutoNavForSuiteRef = useRef<string | null>(null);

  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;
  const isServerConnected =
    selectedServer &&
    selectedServer !== "none" &&
    appState.servers[selectedServer]?.connectionStatus === "connected";

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

  const isRunDetailView = route.type === "run-detail";
  const selectedRunIdForSidebar =
    route.type === "run-detail" ? route.runId : null;
  const { caseGroupsForSelectedRun } = useRunDetailData(
    selectedRunIdForSidebar,
    sortedIterations,
    runDetailSidebarSortBy,
  );
  const selectedRunForSidebar = useMemo(() => {
    if (route.type !== "run-detail") return null;
    return runsForSelectedSuite.find((r) => r._id === route.runId) ?? null;
  }, [route, runsForSelectedSuite]);

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      activeIterations,
    );
  }, [selectedSuite, suiteDetails, activeIterations]);
  const exploreSuite = selectedSuite;
  const exploreCases = suiteDetails?.testCases ?? EMPTY_CASES;

  /** Runs dashboard only: no Explore case sidebar. */
  const isPlaygroundRunsTableOnly =
    exploreSuite != null &&
    route.type === "suite-overview" &&
    route.suiteId === exploreSuite._id &&
    route.view !== "test-cases";

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
    if (globalInitializedExplore.has(selectedServer)) {
      return;
    }

    globalInitializedExplore.add(selectedServer);
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
        globalInitializedExplore.delete(selectedServer);
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

  const playgroundNavigation = useMemo(
    () => createPlaygroundSuiteNavigation(),
    [],
  );

  useEffect(() => {
    if (route.type !== "run-detail") {
      setRunDetailSidebarSortBy("result");
    }
  }, [route.type]);

  useEffect(() => {
    playgroundAutoNavForSuiteRef.current = null;
  }, [exploreSuite?._id, selectedServer]);

  useEffect(() => {
    if (!exploreSuite) return;
    if (route.type !== "list") return;
    if (queries.isSuiteDetailsLoading) return;
    if (playgroundAutoNavForSuiteRef.current === exploreSuite._id) return;

    playgroundAutoNavForSuiteRef.current = exploreSuite._id;
    const firstExploreCase = exploreCases[0];

    if (firstExploreCase) {
      playgroundNavigation.toTestEdit(exploreSuite._id, firstExploreCase._id);
      return;
    }

    navigatePlaygroundEvalsRoute({
      type: "suite-overview",
      suiteId: exploreSuite._id,
      view: "test-cases",
    });
  }, [
    exploreCases,
    exploreSuite,
    playgroundNavigation,
    queries.isSuiteDetailsLoading,
    route.type,
  ]);

  const handleGenerateMore = useCallback(async () => {
    if (!exploreSuite || !selectedServer) return;
    await handlers.handleGenerateTests(exploreSuite._id, [selectedServer]);
  }, [exploreSuite, handlers, selectedServer]);

  const handleRunSelectedExploreCase = useCallback(
    async (testCase: EvalCase) => {
      if (!exploreSuite) return;
      const selectedModel = getPersistedTestCaseModelValue(testCase._id);
      await handlers.handleRunTestCase(exploreSuite, testCase, {
        location: "test_case_list_sidebar",
        selectedModel,
      });
    },
    [exploreSuite, handlers],
  );

  const showExploreLoading =
    isPreparingExplore ||
    (selectedServer &&
      isServerConnected &&
      !exploreSuite &&
      queries.isOverviewLoading);

  const renderExploreMainPanel = () => {
    if (!exploreSuite) return null;
    if (queries.isSuiteDetailsLoading) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">
              Loading cases...
            </p>
          </div>
        </div>
      );
    }
    return (
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
          omitRunIterationList={isRunDetailView}
          runDetailSortByOverride={
            isRunDetailView ? runDetailSidebarSortBy : undefined
          }
          onRunDetailSortByChange={
            isRunDetailView ? setRunDetailSidebarSortBy : undefined
          }
          omitSuiteHeader={isRunDetailView}
          alwaysShowEditIterationRows
          onEditTestCase={(testCaseId) =>
            playgroundNavigation.toTestEdit(exploreSuite._id, testCaseId)
          }
          onRerun={handlers.handleRerun}
          onCancelRun={handlers.handleCancelRun}
          onDelete={handlers.handleDelete}
          onDeleteRun={handlers.handleDeleteRun}
          onDirectDeleteRun={handlers.directDeleteRun}
          connectedServerNames={connectedServerNames}
          canDeleteSuite={canDeleteSuite}
          rerunningSuiteId={handlers.rerunningSuiteId}
          cancellingRunId={handlers.cancellingRunId}
          deletingSuiteId={handlers.deletingSuiteId}
          deletingRunId={handlers.deletingRunId}
          availableModels={availableModels}
          route={route}
          userMap={userMap}
          workspaceId={workspaceId}
          navigation={playgroundNavigation}
          canDeleteRuns={canDeleteRuns}
          hideRunActions
        />
      </div>
    );
  };

  return (
    <EvalTabGate
      variant="playground"
      isLoading={isLoading}
      isAuthenticated={isAuthenticated}
      user={user}
      workspaceId={workspaceId}
    >
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {isPlaygroundRunsTableOnly ? (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {renderExploreMainPanel()}
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
                    {route.type === "run-detail" ? (
                      <RunIterationsSidebar
                        caseGroupsForSelectedRun={caseGroupsForSelectedRun}
                        runDetailSortBy={runDetailSidebarSortBy}
                        onSortChange={setRunDetailSidebarSortBy}
                        selectedIterationId={route.iteration ?? null}
                        onSelectIteration={(iterationId) => {
                          navigatePlaygroundEvalsRoute({
                            type: "run-detail",
                            suiteId: route.suiteId,
                            runId: route.runId,
                            iteration: iterationId,
                          });
                        }}
                        runForOverview={selectedRunForSidebar}
                        onOpenRunInsights={() =>
                          navigatePlaygroundEvalsRoute({
                            type: "run-detail",
                            suiteId: route.suiteId,
                            runId: route.runId,
                            insightsFocus: true,
                          })
                        }
                        runInsightsSelected={Boolean(
                          route.insightsFocus && !route.iteration,
                        )}
                        onEditTestCase={(testCaseId) =>
                          playgroundNavigation.toTestEdit(
                            route.suiteId,
                            testCaseId,
                          )
                        }
                        alwaysShowEditIterationRows
                      />
                    ) : (
                      <TestCaseListSidebar
                        heading="Explore"
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
                          handlers.handleDuplicateTestCase(
                            testCaseId,
                            exploreSuite._id,
                          )
                        }
                        onGenerateTests={() => void handleGenerateMore()}
                        onCopySdkEvalBrief={() =>
                          void handleCopyExploreSdkEvalBrief()
                        }
                        isCopyingSdkEvalBrief={isCopyingExploreSdkBrief}
                        deletingTestCaseId={handlers.deletingTestCaseId}
                        duplicatingTestCaseId={handlers.duplicatingTestCaseId}
                        isGeneratingTests={handlers.isGeneratingTests}
                        showingOverview={!selectedTestId}
                        noServerSelected={!isServerConnected}
                        selectedServer={selectedServer}
                        suite={exploreSuite}
                        connectedServerNames={connectedServerNames}
                        onRunTestCase={handleRunSelectedExploreCase}
                        runningTestCaseId={handlers.runningTestCaseId}
                        showSelection={false}
                        hideRunInsightsRow
                      />
                    )}
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    defaultSize={72}
                    minSize={isRunDetailView ? 42 : 15}
                    className="flex min-h-0 flex-col overflow-hidden"
                  >
                    {renderExploreMainPanel()}
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
            </div>
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
    </EvalTabGate>
  );
}
