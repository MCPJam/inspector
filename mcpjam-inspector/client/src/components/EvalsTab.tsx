import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useMutation } from "convex/react";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { useEvalsRoute } from "@/lib/evals-router";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { aggregateSuite } from "./evals/helpers";
import { EvalTabGate } from "./evals/EvalTabGate";
import {
  createPlaygroundSuiteNavigation,
  navigatePlaygroundEvalsRoute,
} from "./evals/create-suite-navigation";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { useSharedAppState } from "@/state/app-state-context";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { EvalCase } from "./evals/types";
import { EXPLORE_SUITE_TAG, isExploreSuite } from "./evals/constants";
import { shouldAutoOpenPlaygroundCasesView } from "./evals/playground-route-preferences";

interface EvalsTabProps {
  selectedServer?: string;
  workspaceId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
}

const EMPTY_CASES: EvalCase[] = [];

/** Module-level guard so fast tab-switches (unmount/remount) don't duplicate suite creation. */
const globalInitializedExplore = new Set<string>();

export function EvalsTab({
  selectedServer,
  workspaceId,
  onContinueInChat,
}: EvalsTabProps) {
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

  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;
  const isServerConnected =
    selectedServer &&
    selectedServer !== "none" &&
    appState.servers[selectedServer]?.connectionStatus === "connected";

  const hasPlaygroundServerTab =
    Boolean(selectedServer) && selectedServer !== "none";

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
    if (!hasPlaygroundServerTab) return null;
    return (
      manualSuiteEntries.find(
        (entry) =>
          isExploreSuite(entry.suite) &&
          entry.suite.environment?.servers?.[0] === selectedServer,
      ) ?? null
    );
  }, [manualSuiteEntries, selectedServer, hasPlaygroundServerTab]);

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
  const exploreSuite = selectedSuite;
  const exploreCases = suiteDetails?.testCases ?? EMPTY_CASES;

  useEffect(() => {
    if (
      !selectedServer ||
      !isServerConnected ||
      !workspaceId ||
      !isAuthenticated
    ) {
      return;
    }
    // Wait until the overview query has loaded before deciding to create.
    // Otherwise we might not find the existing suite and create a duplicate.
    if (overviewQueries.isOverviewLoading) {
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

          // Auto-generate test cases for the newly created suite
          handlers.handleGenerateTests(createdSuite._id, [selectedServer]);
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
    handlers,
    isServerConnected,
    mutations.createTestSuiteMutation,
    overviewQueries.isOverviewLoading,
    selectedServer,
    updateSuiteMutation,
    workspaceId,
  ]);

  // Auto-generate when an explore suite exists but has no cases (e.g. previous generation failed)
  const hasAutoGeneratedRef = useRef(new Set<string>());
  useEffect(() => {
    if (
      !exploreSuite ||
      !selectedServer ||
      !isServerConnected ||
      handlers.isGeneratingTests
    ) {
      return;
    }
    if (queries.isSuiteDetailsLoading) return;
    if (exploreCases.length > 0) return;
    if (hasAutoGeneratedRef.current.has(exploreSuite._id)) return;

    hasAutoGeneratedRef.current.add(exploreSuite._id);
    handlers.handleGenerateTests(exploreSuite._id, [selectedServer]);
  }, [
    exploreSuite,
    exploreCases.length,
    selectedServer,
    isServerConnected,
    handlers,
    queries.isSuiteDetailsLoading,
  ]);

  const playgroundNavigation = useMemo(
    () => createPlaygroundSuiteNavigation(),
    [],
  );

  useEffect(() => {
    if (!exploreSuite) return;
    if (
      !shouldAutoOpenPlaygroundCasesView({
        route,
        exploreSuiteId: exploreSuite._id,
        isSuiteDetailsLoading: queries.isSuiteDetailsLoading,
        runsCount: runsForSelectedSuite.length,
      })
    ) {
      return;
    }

    navigatePlaygroundEvalsRoute(
      {
        type: "suite-overview",
        suiteId: exploreSuite._id,
        view: "test-cases",
      },
      { replace: route.type !== "test-detail" && route.type !== "test-edit" },
    );
  }, [
    exploreCases.length,
    exploreSuite,
    queries.isSuiteDetailsLoading,
    route,
    runsForSelectedSuite.length,
  ]);

  const handleGenerateMore = useCallback(async () => {
    if (!exploreSuite || !selectedServer) return;
    await handlers.handleGenerateTests(exploreSuite._id, [selectedServer]);
  }, [exploreSuite, handlers, selectedServer]);

  const handleDeleteTestCasesBatch = useCallback(
    async (testCaseIds: string[]) => {
      await Promise.all(
        testCaseIds.map((id) => handlers.directDeleteTestCase(id)),
      );
      if (
        exploreSuite &&
        selectedTestId &&
        testCaseIds.includes(selectedTestId)
      ) {
        navigatePlaygroundEvalsRoute({
          type: "suite-overview",
          suiteId: exploreSuite._id,
          view: "test-cases",
        });
      }
    },
    [exploreSuite, handlers, selectedTestId],
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
          alwaysShowEditIterationRows
          onEditTestCase={(testCaseId) =>
            playgroundNavigation.toTestEdit(exploreSuite._id, testCaseId, {
              openCompare: true,
            })
          }
          onCreateTestCase={async () =>
            handlers.handleCreateTestCase(exploreSuite._id)
          }
          onGenerateTestCases={() => void handleGenerateMore()}
          canGenerateTestCases={Boolean(selectedServer && isServerConnected)}
          isGeneratingTestCases={handlers.isGeneratingTests}
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
          onContinueInChat={onContinueInChat}
          navigation={playgroundNavigation}
          canDeleteRuns={canDeleteRuns}
          hideRunActions
          onDeleteTestCasesBatch={handleDeleteTestCasesBatch}
          onRunTestCase={
            exploreSuite
              ? (tc) => {
                  void (async () => {
                    const data = await handlers.handleRunTestCase(
                      exploreSuite,
                      tc,
                      {
                        location: "test_cases_overview",
                      },
                    );
                    const firstIterationId =
                      data?.iteration?._id ??
                      data?.runs?.find((run: any) => run?.iteration?._id)
                        ?.iteration?._id;
                    if (firstIterationId) {
                      playgroundNavigation.toTestEdit(exploreSuite._id, tc._id, {
                        openCompare: true,
                      });
                    }
                  })();
                }
              : undefined
          }
          runningTestCaseId={handlers.runningTestCaseId}
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
          {!hasPlaygroundServerTab ? (
            <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
              <EmptyState
                icon={FlaskConical}
                title="Select a server to explore"
                description="Pick a server from the header to view Explore cases. Connect it to run tests or generate new cases."
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
              {renderExploreMainPanel()}
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
