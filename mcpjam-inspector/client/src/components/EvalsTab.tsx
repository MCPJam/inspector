import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useMutation } from "convex/react";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { useEvalsRoute } from "@/lib/evals-router";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
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
import { getPlaygroundCasesRedirect } from "./evals/playground-route-preferences";

interface EvalsTabProps {
  selectedServer?: string;
  workspaceId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
}

const EMPTY_CASES: EvalCase[] = [];

/** Module-level guard so fast tab-switches (unmount/remount) don't duplicate suite creation. */
const globalInitializedExplore = new Set<string>();

function getExploreInitializationKey({
  serverName,
  isDirectGuest,
  workspaceId,
}: {
  serverName: string;
  isDirectGuest: boolean;
  workspaceId?: string | null;
}): string {
  const scope = isDirectGuest
    ? "guest"
    : workspaceId
    ? `workspace:${workspaceId}`
    : "anonymous";
  return `${scope}::${serverName}`;
}

export function EvalsTab({
  selectedServer,
  workspaceId,
  onContinueInChat,
}: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const route = useEvalsRoute();
  const appState = useSharedAppState();
  const isDirectGuest = useIsDirectGuest({ workspaceId });
  const {
    connectedServerNames,
    userMap,
    canDeleteSuite,
    canDeleteRuns,
    availableModels,
  } = useEvalTabContext({
    isAuthenticated,
    workspaceId: workspaceId ?? null,
    isDirectGuest,
  });
  const updateSuiteMutation = useMutation("testSuites:updateTestSuite" as any);
  const mutations = useEvalMutations({ isDirectGuest });

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
  const exploreInitializationKey = useMemo(
    () =>
      selectedServer
        ? getExploreInitializationKey({
            serverName: selectedServer,
            isDirectGuest,
            workspaceId,
          })
        : null,
    [selectedServer, isDirectGuest, workspaceId]
  );

  const overviewQueries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(workspaceId),
    user: workspaceId ? user : null,
    selectedSuiteId: null,
    deletingSuiteId: null,
    workspaceId: workspaceId ?? null,
    organizationId: null,
    isDirectGuest,
  });

  const manualSuiteEntries = useMemo(
    () =>
      overviewQueries.sortedSuites.filter(
        (entry) => entry.suite.source !== "sdk"
      ),
    [overviewQueries.sortedSuites]
  );

  const exploreSuiteEntry = useMemo(() => {
    if (!hasPlaygroundServerTab) return null;
    return (
      manualSuiteEntries.find(
        (entry) =>
          isExploreSuite(entry.suite) &&
          entry.suite.environment?.servers?.[0] === selectedServer
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
    isDirectGuest,
  });
  const {
    deletingSuiteId,
    rerunningSuiteId,
    cancellingRunId,
    deletingRunId,
    isGeneratingTests,
    handleCreateTestCase,
    handleGenerateTests,
    handleRerun,
    handleCancelRun,
    handleDelete,
    handleDeleteRun,
    directDeleteRun,
    directDeleteTestCase,
  } = handlers;

  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(workspaceId),
    user: workspaceId ? user : null,
    selectedSuiteId,
    deletingSuiteId,
    workspaceId: workspaceId ?? null,
    organizationId: null,
    isDirectGuest,
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
      activeIterations
    );
  }, [selectedSuite, suiteDetails, activeIterations]);
  const exploreSuite = selectedSuite;
  const exploreCases = suiteDetails?.testCases ?? EMPTY_CASES;
  const exploreCaseIdsSignature = useMemo(
    () => exploreCases.map((testCase) => testCase._id).join("\u0000"),
    [exploreCases]
  );
  const exploreRunIdsSignature = useMemo(
    () => runsForSelectedSuite.map((run) => run._id).join("\u0000"),
    [runsForSelectedSuite]
  );
  const iterationRunIdsSignature = useMemo(
    () =>
      sortedIterations
        .flatMap((iteration) =>
          iteration.suiteRunId ? [iteration.suiteRunId] : []
        )
        .join("\u0000"),
    [sortedIterations]
  );

  useEffect(() => {
    if (!selectedServer || selectedServer === "none") {
      return;
    }
    if (!isDirectGuest) {
      // Signed-in path still waits for a live connection before calling the
      // create mutation (and the auto-generate that follows).
      if (!isServerConnected) {
        return;
      }
      if (!workspaceId || !isAuthenticated) {
        return;
      }
    }
    // Wait until the overview query has loaded before deciding to create.
    // Otherwise we might not find the existing suite and create a duplicate.
    if (overviewQueries.isOverviewLoading) {
      return;
    }
    if (selectedSuiteId) {
      return;
    }
    if (!exploreInitializationKey) {
      return;
    }
    if (globalInitializedExplore.has(exploreInitializationKey)) {
      return;
    }

    globalInitializedExplore.add(exploreInitializationKey);
    setIsPreparingExplore(true);

    void (async () => {
      try {
        const createdSuite = await mutations.createTestSuiteMutation({
          ...(isDirectGuest ? {} : { workspaceId }),
          name: selectedServer,
          description: `Explore cases for ${selectedServer}`,
          environment: { servers: [selectedServer] },
        });

        if (createdSuite?._id) {
          await updateSuiteMutation({
            suiteId: createdSuite._id,
            tags: [EXPLORE_SUITE_TAG],
          });

          if (!isDirectGuest) {
            // Signed-in workspaces auto-generate starter cases.
            // Direct guests keep the lighter PR 1848 behavior and opt in
            // manually so we do not hit the generation endpoint on load.
            handleGenerateTests(createdSuite._id, [selectedServer]);
          }
        }
      } catch (error) {
        globalInitializedExplore.delete(exploreInitializationKey);
        toast.error(
          getBillingErrorMessage(
            error,
            "Failed to create the Explore workspace"
          )
        );
      } finally {
        setIsPreparingExplore(false);
      }
    })();
  }, [
    isAuthenticated,
    handleGenerateTests,
    isServerConnected,
    mutations.createTestSuiteMutation,
    overviewQueries.isOverviewLoading,
    selectedServer,
    selectedSuiteId,
    exploreInitializationKey,
    updateSuiteMutation,
    workspaceId,
    isDirectGuest,
  ]);

  // Auto-generate when an explore suite exists but has no cases (e.g. previous generation failed)
  const hasAutoGeneratedRef = useRef(new Set<string>());
  useEffect(() => {
    if (
      !selectedSuiteId ||
      !selectedServer ||
      !isServerConnected ||
      isGeneratingTests
    ) {
      return;
    }
    // Guests opt into generation manually; don't auto-run on empty suites.
    if (isDirectGuest) return;
    if (queries.isSuiteDetailsLoading) return;
    if (exploreCases.length > 0) return;
    if (hasAutoGeneratedRef.current.has(selectedSuiteId)) return;

    hasAutoGeneratedRef.current.add(selectedSuiteId);
    handleGenerateTests(selectedSuiteId, [selectedServer]);
  }, [
    exploreCases.length,
    handleGenerateTests,
    isGeneratingTests,
    selectedServer,
    selectedSuiteId,
    isServerConnected,
    queries.isSuiteDetailsLoading,
    isDirectGuest,
  ]);

  const playgroundNavigation = useMemo(
    () => createPlaygroundSuiteNavigation(),
    []
  );

  useEffect(() => {
    if (!selectedSuiteId) return;
    const testCaseIds = exploreCaseIdsSignature
      ? exploreCaseIdsSignature.split("\u0000")
      : [];
    const runIds = exploreRunIdsSignature
      ? exploreRunIdsSignature.split("\u0000")
      : [];
    const iterationRunIds = iterationRunIdsSignature
      ? iterationRunIdsSignature.split("\u0000")
      : [];
    const redirectRoute = getPlaygroundCasesRedirect({
      route,
      exploreSuiteId: selectedSuiteId,
      isSuiteDetailsLoading: queries.isSuiteDetailsLoading,
      isSuiteRunsLoading: queries.isSuiteRunsLoading,
      testCaseIds,
      runIds,
      iterationRunIds,
    });
    if (!redirectRoute) {
      return;
    }

    navigatePlaygroundEvalsRoute(redirectRoute, { replace: true });
  }, [
    exploreCaseIdsSignature,
    exploreRunIdsSignature,
    iterationRunIdsSignature,
    queries.isSuiteDetailsLoading,
    queries.isSuiteRunsLoading,
    route,
    selectedSuiteId,
  ]);

  const handleGenerateMore = useCallback(async () => {
    if (!selectedSuiteId || !selectedServer) return;
    await handleGenerateTests(selectedSuiteId, [selectedServer]);
  }, [handleGenerateTests, selectedServer, selectedSuiteId]);

  const handleDeleteTestCasesBatch = useCallback(
    async (testCaseIds: string[]) => {
      const settledDeletes = await Promise.allSettled(
        testCaseIds.map(async (id) => {
          await directDeleteTestCase(id);
          return id;
        })
      );
      const deletedIds = new Set(
        settledDeletes.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        )
      );
      const failedDeletes = settledDeletes.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );

      if (failedDeletes.length > 0) {
        console.error("Failed to delete some test cases:", failedDeletes);
        toast.error(
          `Failed to delete ${failedDeletes.length} test case${
            failedDeletes.length === 1 ? "" : "s"
          }.`
        );
      }

      if (selectedSuiteId && selectedTestId && deletedIds.has(selectedTestId)) {
        navigatePlaygroundEvalsRoute(
          {
            type: "suite-overview",
            suiteId: selectedSuiteId,
            view: "test-cases",
          },
          { replace: true }
        );
      }
    },
    [directDeleteTestCase, selectedSuiteId, selectedTestId]
  );

  const showExploreLoading =
    isPreparingExplore ||
    (selectedServer &&
      !exploreSuite &&
      queries.isOverviewLoading &&
      (isDirectGuest || isServerConnected));

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
          isDirectGuest={isDirectGuest}
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
          onCreateTestCase={async () => handleCreateTestCase(exploreSuite._id)}
          onGenerateTestCases={() => void handleGenerateMore()}
          canGenerateTestCases={Boolean(selectedServer && isServerConnected)}
          isGeneratingTestCases={isGeneratingTests}
          onRerun={handleRerun}
          onCancelRun={handleCancelRun}
          onDelete={handleDelete}
          onDeleteRun={handleDeleteRun}
          onDirectDeleteRun={directDeleteRun}
          connectedServerNames={connectedServerNames}
          canDeleteSuite={canDeleteSuite}
          rerunningSuiteId={rerunningSuiteId}
          cancellingRunId={cancellingRunId}
          deletingSuiteId={deletingSuiteId}
          deletingRunId={deletingRunId}
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
                      }
                    );
                    const firstIterationId =
                      data?.iteration?._id ??
                      data?.runs?.find((run: any) => run?.iteration?._id)
                        ?.iteration?._id;
                    if (firstIterationId) {
                      playgroundNavigation.toTestEdit(
                        exploreSuite._id,
                        tc._id,
                        {
                          openCompare: true,
                          iteration: firstIterationId,
                        }
                      );
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
      isDirectGuest={isDirectGuest}
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
