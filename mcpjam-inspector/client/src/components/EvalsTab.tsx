import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvex, useConvexAuth } from "convex/react";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { Button } from "@mcpjam/design-system/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useWorkspaceServers } from "@/hooks/useViews";
import { useEvalsRoute } from "@/lib/evals-router";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import { useSharedAppState } from "@/state/app-state-context";
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
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { EvalsSuiteListSidebar } from "./evals/evals-suite-list-sidebar";
import {
  PlaygroundSuitesExecutionsTabs,
  type PlaygroundWorkspaceBrowse,
} from "./evals/playground-suites-executions-tabs";
import { CreateSuiteDialog } from "./evals/create-suite-dialog";
import { SuiteExecutionsOverview } from "./evals/suite-executions-overview";
import { usePlaygroundWorkspaceExecutions } from "./evals/use-playground-workspace-executions";
import type { EvalIteration } from "./evals/types";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import { isExploreSuite } from "./evals/constants";
import { generateAndPersistEvalTests } from "@/lib/evals/generate-and-persist-tests";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

const FIRST_SUITE_EMPTY_DESCRIPTION =
  "A suite groups eval cases with the MCP servers they use. Create one, then generate cases or import a chat transcript.";

const workspaceServerKey = (workspaceId: string, serverName: string) =>
  `${workspaceId}::${serverName}`;

// Module-scoped so an in-flight explore-suite create still blocks duplicate
// creates if the EvalsTab unmounts and remounts before the create finishes.
// Keyed by `${workspaceId}::${serverName}` so different workspaces don't share.
const explorePrefetchInFlight = new Set<string>();

interface EvalsTabProps {
  workspaceId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
}

export function EvalsTab({
  workspaceId,
  onContinueInChat,
  ensureServersReady,
}: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const convex = useConvex();
  const { user, getAccessToken } = useAuth();
  const route = useEvalsRoute();
  const appState = useSharedAppState();
  const [workspaceBrowse, setWorkspaceBrowse] =
    useState<PlaygroundWorkspaceBrowse>("suites");
  const [locallySuppressedServerKeys, setLocallySuppressedServerKeys] =
    useState<string[]>([]);
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
  const { servers: workspaceServers = [] } = useWorkspaceServers({
    isAuthenticated,
    workspaceId: workspaceId ?? null,
  });
  const mutations = useEvalMutations({ isDirectGuest });

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

  useLayoutEffect(() => {
    if (
      route.type === "suite-overview" ||
      route.type === "run-detail" ||
      route.type === "test-detail" ||
      route.type === "test-edit" ||
      route.type === "suite-edit"
    ) {
      setWorkspaceBrowse("suites");
    }
  }, [route]);

  const overviewQueries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(workspaceId),
    user: workspaceId ? user : null,
    selectedSuiteId: null,
    deletingSuiteId: null,
    workspaceId: workspaceId ?? null,
    organizationId: null,
    isDirectGuest,
  });

  const visibleSuites = useMemo(
    () =>
      overviewQueries.sortedSuites.filter((entry) => entry.suite.source !== "sdk"),
    [overviewQueries.sortedSuites],
  );

  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId) {
      return null;
    }
    return (
      visibleSuites.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [selectedSuiteId, visibleSuites]);

  const latestRunBySuiteId = useMemo(
    () =>
      new Map(
        visibleSuites.map((entry) => [entry.suite._id, entry.latestRun ?? null]),
      ),
    [visibleSuites],
  );

  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry,
    selectedSuiteId,
    selectedTestId,
    workspaceId: workspaceId ?? null,
    connectedServerNames,
    ensureServersReady,
    latestRunBySuiteId,
    workspaceServers,
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
  const playgroundNavigation = useMemo(
    () => createPlaygroundSuiteNavigation(),
    []
  );

  const playgroundWorkspaceSuiteIds = useMemo(
    () => visibleSuites.map((entry) => entry.suite._id),
    [visibleSuites],
  );

  const workspaceExecutions = usePlaygroundWorkspaceExecutions({
    enabled:
      isAuthenticated &&
      Boolean(workspaceId) &&
      !overviewQueries.isOverviewLoading &&
      visibleSuites.length > 0 &&
      workspaceBrowse === "executions" &&
      selectedSuiteId === null,
    suiteIds: playgroundWorkspaceSuiteIds,
  });

  const handleWorkspaceExecutionOpen = useCallback(
    (iteration: EvalIteration) => {
      const suiteId =
        workspaceExecutions.iterationToSuiteId.get(iteration._id) ??
        (iteration.testCaseId
          ? workspaceExecutions.cases.find((c) => c._id === iteration.testCaseId)
              ?.testSuiteId
          : undefined);
      if (!suiteId) {
        return;
      }
      if (iteration.testCaseId) {
        playgroundNavigation.toTestEdit(suiteId, iteration.testCaseId, {
          openCompare: true,
          iteration: iteration._id,
        });
      } else if (iteration.suiteRunId) {
        playgroundNavigation.toRunDetail(
          suiteId,
          iteration.suiteRunId,
          iteration._id,
        );
      }
    },
    [
      playgroundNavigation,
      workspaceExecutions.cases,
      workspaceExecutions.iterationToSuiteId,
    ],
  );

  useEffect(() => {
    if (route.type === "list" || route.type === "create") {
      return;
    }
    if (!selectedSuiteId) {
      return;
    }
    if (overviewQueries.isOverviewLoading) {
      return;
    }
    if (!selectedSuiteEntry) {
      navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
    }
  }, [overviewQueries.isOverviewLoading, route.type, selectedSuiteEntry, selectedSuiteId]);

  // ---------------------------------------------------------------------------
  // Auto-create a Playground suite for each connected server that doesn't have
  // one, unless that server's auto-suite has been explicitly deleted.
  // ---------------------------------------------------------------------------
  const ensureAutoEvalSuiteMutation = mutations.ensureAutoEvalSuiteMutation;
  const createTestCaseMutation = mutations.createTestCaseMutation;

  useEffect(() => {
    if (
      !isAuthenticated ||
      !workspaceId ||
      overviewQueries.isOverviewLoading ||
      connectedServerNames.size === 0
    ) {
      return;
    }

    // Find connected servers that don't already have an explore suite
    const serversWithExploreSuite = new Set(
      visibleSuites
        .filter((entry) => isExploreSuite(entry.suite))
        .flatMap((entry) => entry.suite.environment?.servers ?? []),
    );

    const inFlightKeyFor = (serverName: string) =>
      workspaceServerKey(workspaceId, serverName);

    const serversNeedingSuite = [...connectedServerNames].filter(
      (name) =>
        !serversWithExploreSuite.has(name) &&
        appState.servers[name]?.autoEvalSuiteSuppressedAt === undefined &&
        !locallySuppressedServerKeys.includes(
          workspaceServerKey(workspaceId, name),
        ) &&
        !explorePrefetchInFlight.has(inFlightKeyFor(name)),
    );

    if (serversNeedingSuite.length === 0) {
      return;
    }

    for (const serverName of serversNeedingSuite) {
      const inFlightKey = inFlightKeyFor(serverName);
      explorePrefetchInFlight.add(inFlightKey);

      void (async () => {
        try {
          const result = await ensureAutoEvalSuiteMutation({
            workspaceId,
            serverName,
            mode: "auto",
          });

          if (result.status === "suppressed") {
            setLocallySuppressedServerKeys((previous) =>
              previous.includes(workspaceServerKey(workspaceId, serverName))
                ? previous
                : [...previous, workspaceServerKey(workspaceId, serverName)],
            );
            return;
          }

          if (result.status !== "created") {
            return;
          }

          const outcome = await generateAndPersistEvalTests({
            convex,
            getAccessToken,
            workspaceId,
            suiteId: result.suite._id,
            serverIds: [serverName],
            createTestCase: createTestCaseMutation,
          });

          if (outcome.createdCount > 0) {
            posthog.capture("eval_explore_cases_prefetched_on_connect", {
              location: "playground_tab",
              platform: detectPlatform(),
              environment: detectEnvironment(),
              workspace_id: workspaceId,
              server_name: serverName,
              suite_id: result.suite._id,
              generated_count: outcome.createdCount,
            });
          }
        } catch (error) {
          console.error("Explore suite auto-create failed:", error);
        } finally {
          explorePrefetchInFlight.delete(inFlightKey);
        }
      })();
    }
  }, [
    isAuthenticated,
    workspaceId,
    appState.servers,
    connectedServerNames,
    locallySuppressedServerKeys,
    visibleSuites,
    overviewQueries.isOverviewLoading,
    convex,
    getAccessToken,
    ensureAutoEvalSuiteMutation,
    createTestCaseMutation,
  ]);

  const handleOpenCreateSuite = useCallback(() => {
    navigatePlaygroundEvalsRoute({ type: "create" });
  }, []);

  const handleCreateDialogChange = useCallback(
    (open: boolean) => {
      if (!open) {
        navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
      }
    },
    [],
  );

  const handleCreateSuite = useCallback(
    async (payload: {
      name: string;
      description?: string;
      selectedServers: string[];
    }) => {
      if (!workspaceId) {
        return;
      }

      try {
        const singleServerName =
          payload.selectedServers.length === 1
            ? payload.selectedServers[0]
            : null;
        const isSuppressedAutoSuiteRecreate = Boolean(
          singleServerName &&
            (appState.servers[singleServerName]?.autoEvalSuiteSuppressedAt !==
              undefined ||
              locallySuppressedServerKeys.includes(
                workspaceServerKey(workspaceId, singleServerName),
              )),
        );

        if (singleServerName && isSuppressedAutoSuiteRecreate) {
          const result = await mutations.ensureAutoEvalSuiteMutation({
            workspaceId,
            serverName: singleServerName,
            mode: "manual",
          });

          const nextDescription = payload.description ?? "";
          const suiteUpdates: {
            suiteId: string;
            name?: string;
            description?: string;
          } = {
            suiteId: result.suite._id,
          };

          if (payload.name !== result.suite.name) {
            suiteUpdates.name = payload.name;
          }
          if (nextDescription !== (result.suite.description ?? "")) {
            suiteUpdates.description = nextDescription;
          }
          if (
            suiteUpdates.name !== undefined ||
            suiteUpdates.description !== undefined
          ) {
            await mutations.updateTestSuiteMutation(suiteUpdates);
          }

          if (
            result.status === "created" &&
            connectedServerNames.has(singleServerName)
          ) {
            await generateAndPersistEvalTests({
              convex,
              getAccessToken,
              workspaceId,
              suiteId: result.suite._id,
              serverIds: [singleServerName],
              createTestCase: createTestCaseMutation,
            });
          }

          setLocallySuppressedServerKeys((previous) =>
            previous.filter(
              (serverKey) =>
                serverKey !== workspaceServerKey(workspaceId, singleServerName),
            ),
          );

          toast.success("Suite created");
          navigatePlaygroundEvalsRoute({
            type: "suite-overview",
            suiteId: result.suite._id,
          });
          return;
        }

        const createdSuite = await mutations.createTestSuiteMutation({
          workspaceId,
          name: payload.name,
          description: payload.description,
          environment: {
            servers: payload.selectedServers,
          },
        });

        if (!createdSuite?._id) {
          throw new Error("Suite was created without an id");
        }

        toast.success("Suite created");
        navigatePlaygroundEvalsRoute({
          type: "suite-overview",
          suiteId: createdSuite._id,
        });
      } catch (error) {
        toast.error(getBillingErrorMessage(error, "Failed to create suite"));
        throw error;
      }
    },
    [
      appState.servers,
      connectedServerNames,
      convex,
      createTestCaseMutation,
      getAccessToken,
      locallySuppressedServerKeys,
      mutations.createTestSuiteMutation,
      mutations.ensureAutoEvalSuiteMutation,
      mutations.updateTestSuiteMutation,
      workspaceId,
    ],
  );

  const handleWorkspaceBrowseChange = useCallback(
    (value: PlaygroundWorkspaceBrowse) => {
      if (
        selectedSuiteId &&
        (value === "executions" || value === "suites")
      ) {
        navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
      }
      setWorkspaceBrowse(value);
    },
    [selectedSuiteId],
  );

  const handleSelectSuite = useCallback((suiteId: string) => {
    setWorkspaceBrowse("suites");
    navigatePlaygroundEvalsRoute({ type: "suite-overview", suiteId });
  }, []);

  const handleGenerateMore = useCallback(async () => {
    if (!selectedSuite) return;
    const suiteServers = selectedSuite.environment?.servers ?? [];
    if (suiteServers.length === 0) return;
    await handlers.handleGenerateTests(selectedSuite._id, suiteServers);
  }, [handlers, selectedSuite]);

  const generateState = useMemo(() => {
    const suiteServers = selectedSuite?.environment?.servers ?? [];
    if (suiteServers.length === 0) {
      return {
        canGenerate: false,
        disabledReason:
          "Add at least one server to this suite in Edit suite before generating cases.",
      };
    }

    const missingServers = suiteServers.filter(
      (serverName) => !connectedServerNames.has(serverName),
    );
    if (missingServers.length > 0) {
      if (ensureServersReady) {
        return {
          canGenerate: true,
          disabledReason:
            "Connects the suite’s MCP servers if needed, then creates suggested test cases.",
        };
      }
      return {
        canGenerate: false,
        disabledReason: `Connect ${missingServers.join(", ")} to generate cases for this suite.`,
      };
    }

    return {
      canGenerate: true,
      disabledReason:
        "Generate suggested cases from this suite’s servers. Open a case to run it when you are ready.",
    };
  }, [connectedServerNames, ensureServersReady, selectedSuite]);

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
    [directDeleteTestCase, selectedSuiteId, selectedTestId],
  );

  const handleDeleteSuitesBatch = useCallback(
    async (suiteIds: string[]) => {
      const settledDeletes = await Promise.allSettled(
        suiteIds.map((suiteId) =>
          mutations.deleteSuiteMutation({ suiteId }),
        ),
      );
      const succeededIds = new Set<string>();
      settledDeletes.forEach((result, i) => {
        if (result.status === "fulfilled") {
          succeededIds.add(suiteIds[i]);
        }
      });
      const failedDeletes = settledDeletes.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (failedDeletes.length > 0) {
        console.error("Failed to delete some suites:", failedDeletes);
        if (succeededIds.size > 0) {
          toast.error(
            `Deleted ${succeededIds.size} suite${
              succeededIds.size === 1 ? "" : "s"
            }; ${failedDeletes.length} failed.`,
          );
        } else {
          toast.error(
            getBillingErrorMessage(
              failedDeletes[0]?.reason,
              "Failed to delete suites",
            ),
          );
        }
      } else {
        toast.success(
          suiteIds.length === 1
            ? "Suite deleted"
            : `Deleted ${suiteIds.length} suites`,
        );
      }

      if (selectedSuiteId && succeededIds.has(selectedSuiteId)) {
        navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
      }
    },
    [mutations.deleteSuiteMutation, selectedSuiteId],
  );

  const renderSuitesBrowsePanel = () => {
    if (overviewQueries.isOverviewLoading) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">
              Loading suites...
            </p>
          </div>
        </div>
      );
    }

    if (visibleSuites.length === 0) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="max-w-md text-center">
            <EmptyState
              icon={FlaskConical}
              title="Create your first suite"
              description={FIRST_SUITE_EMPTY_DESCRIPTION}
              className="h-auto"
            >
              <Button type="button" onClick={handleOpenCreateSuite}>
                Create suite
              </Button>
            </EmptyState>
          </div>
        </div>
      );
    }

    if (
      selectedSuiteId &&
      (route.type === "suite-overview" ||
        route.type === "run-detail" ||
        route.type === "test-detail" ||
        route.type === "test-edit" ||
        route.type === "suite-edit")
    ) {
      if (queries.isSuiteDetailsLoading) {
        return (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
              <p className="mt-4 text-sm text-muted-foreground">
                Loading suite data...
              </p>
            </div>
          </div>
        );
      }

      return renderSuiteIterationsDetail();
    }

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-3">
        <EvalsSuiteListSidebar
          suites={visibleSuites}
          selectedSuiteId={selectedSuiteId}
          onSelectSuite={handleSelectSuite}
          onCreateSuite={handleOpenCreateSuite}
          isLoading={false}
          canDeleteSuites={canDeleteSuite}
          onDeleteSuitesBatch={handleDeleteSuitesBatch}
          deleteInProgress={Boolean(handlers.deletingSuiteId)}
          onRunAll={handlers.handleRerun}
          rerunningSuiteId={handlers.rerunningSuiteId}
          replayingRunId={handlers.replayingRunId}
          runningTestCaseId={handlers.runningTestCaseId}
        />
      </div>
    );
  };

  const renderSuiteIterationsDetail = () => {
    if (!selectedSuite) {
      return null;
    }

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-6 pb-6 pt-6">
        <SuiteIterationsView
          isDirectGuest={isDirectGuest}
          ensureServersReady={ensureServersReady}
          suite={selectedSuite}
          cases={suiteDetails?.testCases ?? []}
          iterations={activeIterations}
          allIterations={sortedIterations}
          runs={runsForSelectedSuite}
          runsLoading={queries.isSuiteRunsLoading}
          aggregate={suiteAggregate}
          alwaysShowEditIterationRows
          onEditTestCase={(testCaseId) =>
            playgroundNavigation.toTestEdit(selectedSuite._id, testCaseId, {
              openCompare: true,
            })
          }
          onCreateTestCase={async () =>
            handlers.handleCreateTestCase(selectedSuite._id)
          }
          onGenerateTestCases={() => void handleGenerateMore()}
          canGenerateTestCases={generateState.canGenerate}
          generateTestCasesDisabledReason={generateState.disabledReason}
          isGeneratingTestCases={handlers.isGeneratingTests}
          onRerun={handlers.handleRerun}
          onCancelRun={handlers.handleCancelRun}
          onDelete={handlers.handleDelete}
          onDeleteRun={handlers.handleDeleteRun}
          onDirectDeleteRun={handlers.directDeleteRun}
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
          navigation={playgroundNavigation}
          onContinueInChat={onContinueInChat}
          canDeleteRuns={canDeleteRuns}
          hideRunActions
          onDeleteTestCasesBatch={handleDeleteTestCasesBatch}
          onRunTestCase={(testCase) => {
            void (async () => {
              const data = await handlers.handleRunTestCase(
                selectedSuite,
                testCase,
                {
                  location: "test_cases_overview",
                },
              );
              const firstIterationId =
                data?.iteration?._id ??
                data?.runs?.find((run: any) => run?.iteration?._id)?.iteration
                  ?._id;
              if (firstIterationId) {
                playgroundNavigation.toTestEdit(
                  selectedSuite._id,
                  testCase._id,
                  {
                    openCompare: true,
                    iteration: firstIterationId,
                  },
                );
              }
            })();
          }}
          runningTestCaseId={handlers.runningTestCaseId}
          workspaceServers={workspaceServers}
        />
      </div>
    );
  };

  const renderExecutionsBrowsePanel = () => {
    if (overviewQueries.isOverviewLoading) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">
              Loading suites...
            </p>
          </div>
        </div>
      );
    }

    if (visibleSuites.length === 0) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="max-w-md text-center">
            <EmptyState
              icon={FlaskConical}
              title="Create your first suite"
              description={FIRST_SUITE_EMPTY_DESCRIPTION}
              className="h-auto"
            >
              <Button type="button" onClick={handleOpenCreateSuite}>
                Create suite
              </Button>
            </EmptyState>
          </div>
        </div>
      );
    }

    if (!selectedSuiteId) {
      if (
        workspaceExecutions.status === "loading" ||
        workspaceExecutions.status === "idle"
      ) {
        return (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col px-5 pb-5 pt-3">
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <p className="mt-4 text-sm text-muted-foreground">
                  Loading executions...
                </p>
              </div>
            </div>
          </div>
        );
      }

      if (workspaceExecutions.status === "error") {
        return (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <p className="text-center text-sm text-muted-foreground">
              Could not load executions. Try again in a moment.
            </p>
          </div>
        );
      }

      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-3">
          <SuiteExecutionsOverview
            cases={workspaceExecutions.cases}
            allIterations={workspaceExecutions.iterations}
            onOpenIteration={handleWorkspaceExecutionOpen}
            className="min-h-0 flex-1 max-h-none"
            listClassName="min-h-0 flex-1"
          />
        </div>
      );
    }

    return null;
  };

  const showWorkspaceBrowseTabs =
    !overviewQueries.isOverviewLoading && visibleSuites.length > 0;

  const renderPlaygroundBody = () => {
    if (!showWorkspaceBrowseTabs) {
      return renderSuitesBrowsePanel();
    }

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <PlaygroundSuitesExecutionsTabs
          value={workspaceBrowse}
          onChange={handleWorkspaceBrowseChange}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {workspaceBrowse === "suites"
            ? renderSuitesBrowsePanel()
            : renderExecutionsBrowsePanel()}
        </div>
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
      <>
        <CreateSuiteDialog
          open={route.type === "create"}
          onOpenChange={handleCreateDialogChange}
          workspaceServers={workspaceServers}
          connectedServerNames={connectedServerNames}
          onSubmit={handleCreateSuite}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {renderPlaygroundBody()}

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
      </>
    </EvalTabGate>
  );
}
