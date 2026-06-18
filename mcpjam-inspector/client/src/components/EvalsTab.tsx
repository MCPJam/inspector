import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvex, useConvexAuth, useMutation } from "convex/react";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import { EvalsEmptyHero } from "./evals/evals-empty-hero";
import {
  runExcalidrawQuickstart,
  EXCALIDRAW_QUICKSTART_SUITE_NAME,
} from "@/lib/evals/excalidraw-quickstart";
import {
  loadGenerateConfig,
  toGenerationOptions,
} from "@/lib/evals/eval-generation-config";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import { isQuickstartSuite } from "./evals/constants";
import type { ServerFormData } from "@/shared/types.js";
import { useProjectServers } from "@/hooks/useViews";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useEvalsRouteFromUrl } from "@/lib/eval-route-url";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import {
  aggregateSuite,
  formatRunId,
  getEffectiveSuiteServers,
} from "./evals/helpers";
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
  CreateSuiteDialog,
  type CreateSuitePayload,
} from "./evals/create-suite-dialog";
import { getEvalIterationQuotaDisabledReason } from "@/lib/eval-iteration-quota";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";

interface EvalsTabProps {
  projectId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  ensureServersReady?: (
    serverNames: string[]
  ) => Promise<EnsureServersReadyResult>;
  handleConnect?: (config: ServerFormData) => void;
}

export function EvalsTab({
  projectId,
  onContinueInChat,
  ensureServersReady,
  handleConnect,
}: EvalsTabProps) {
  const { isAuthenticated } = useConvexAuth();

  return (
    <ErrorBoundary
      key={`${projectId ?? "none"}:${isAuthenticated ? "authed" : "guest"}`}
      fallback={({ error, reset }) => (
        <EvalTabErrorFallback error={error} onRetry={reset} />
      )}
    >
      <EvalsTabContent
        projectId={projectId}
        onContinueInChat={onContinueInChat}
        ensureServersReady={ensureServersReady}
        handleConnect={handleConnect}
      />
    </ErrorBoundary>
  );
}

function EvalTabErrorFallback({
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <div className="p-6">
      <EmptyState
        icon={FlaskConical}
        title="Could not load Testing"
        description="Something went wrong while loading suites. Try again in a moment."
        className="h-[calc(100vh-200px)]"
      >
        <Button type="button" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </EmptyState>
    </div>
  );
}

function EvalsTabContent({
  projectId,
  onContinueInChat,
  ensureServersReady,
  handleConnect,
}: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  // create-suite-dialog uses `hostsEnabled` as both a feature gate AND a
  // "skeleton suite creation requires attachments" gate (attachmentsRequired
  // = hostsEnabled && projectId), so it stays auth-gated rather than
  // unconditionally on.
  const hostsEnabled = isAuthenticated;
  const route = useEvalsRouteFromUrl();
  const isDirectGuest = useIsDirectGuest({ projectId });
  const [previewedHostId] = usePreviewedHostId(projectId ?? null);
  const {
    organizationId,
    connectedServerNames,
    userMap,
    canDeleteSuite,
    canDeleteRuns,
    availableModels,
  } = useEvalTabContext({
    isAuthenticated,
    projectId: projectId ?? null,
    isDirectGuest,
  });
  const { quota: evalIterationQuota } = useEvalIterationQuota({
    organizationId,
    enabled: Boolean(organizationId),
  });
  const evalRunsDisabledReason = useMemo(
    () => getEvalIterationQuotaDisabledReason(evalIterationQuota),
    [evalIterationQuota]
  );
  const { servers: projectServers = [] } = useProjectServers({
    isAuthenticated,
    projectId: projectId ?? null,
  });
  const mutations = useEvalMutations({ isDirectGuest });
  const convex = useConvex();
  const createServerAttachmentMutation = useMutation(
    "serverAttachments:createServerAttachment" as any
  ) as unknown as (args: {
    projectId: string;
    name: string;
    serverIds: string[];
  }) => Promise<{ _id: string }>;

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

  const overviewQueries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId: null,
    deletingSuiteId: null,
    projectId: projectId ?? null,
    organizationId: null,
    isDirectGuest,
  });

  const visibleSuites = useMemo(
    () =>
      overviewQueries.sortedSuites.filter(
        (entry) => entry.suite.source !== "sdk"
      ),
    [overviewQueries.sortedSuites]
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
        visibleSuites.map((entry) => [entry.suite._id, entry.latestRun ?? null])
      ),
    [visibleSuites]
  );

  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry,
    selectedSuiteId,
    selectedTestId,
    projectId: projectId ?? null,
    connectedServerNames,
    ensureServersReady,
    latestRunBySuiteId,
    projectServers,
    isDirectGuest,
    availableModels,
  });
  const {
    deletingSuiteId,
    rerunningSuiteId,
    cancellingRunId,
    deletingRunId,
    directDeleteTestCase,
  } = handlers;

  const guardEvalIterationQuota = useCallback(() => {
    if (!evalRunsDisabledReason) {
      return true;
    }
    toast.error(evalRunsDisabledReason);
    return false;
  }, [evalRunsDisabledReason]);

  const handleRerunWithQuota = useCallback(
    (...args: Parameters<typeof handlers.handleRerun>) => {
      if (!guardEvalIterationQuota()) {
        return;
      }
      return handlers.handleRerun(...args);
    },
    [guardEvalIterationQuota, handlers]
  );

  const handleRunTestCaseWithQuota = useCallback(
    (...args: Parameters<typeof handlers.handleRunTestCase>) => {
      if (!guardEvalIterationQuota()) {
        return Promise.resolve(null);
      }
      return handlers.handleRunTestCase(...args);
    },
    [guardEvalIterationQuota, handlers]
  );

  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId,
    deletingSuiteId,
    projectId: projectId ?? null,
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
  }, [
    overviewQueries.isOverviewLoading,
    route.type,
    selectedSuiteEntry,
    selectedSuiteId,
  ]);

  // Wait for auth to settle before firing view events. The parent
  // ErrorBoundary keys on (projectId, isAuthenticated), so projectId
  // resolving null→"x" remounts this component and would otherwise
  // double-fire (once on the null mount, once on the resolved mount).
  useEffect(() => {
    if (isLoading) return;
    posthog.capture("evaluate_tab_viewed", {
      location: "evals_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      project_id: projectId ?? null,
    });
  }, [isLoading, projectId]);

  useEffect(() => {
    if (isLoading) return;
    if (!selectedSuiteId) return;
    posthog.capture("suite_viewed", {
      location: "evals_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      project_id: projectId ?? null,
      suite_id: selectedSuiteId,
      route_type: route.type,
    });
  }, [isLoading, selectedSuiteId, route.type, projectId]);

  const handleOpenCreateSuite = useCallback(() => {
    navigatePlaygroundEvalsRoute({ type: "create" });
  }, []);

  const [isQuickstartRunning, setIsQuickstartRunning] = useState(false);

  const existingQuickstartSuiteId = useMemo(() => {
    const match = visibleSuites.find(
      (entry) =>
        isQuickstartSuite(entry.suite) ||
        entry.suite.name === EXCALIDRAW_QUICKSTART_SUITE_NAME
    );
    return match?.suite._id ?? null;
  }, [visibleSuites]);

  const handleExcalidrawQuickstart = useCallback(async () => {
    if (!handleConnect || isQuickstartRunning) return;
    if (!projectId) {
      toast.error("Select or create a project before running the quickstart.");
      return;
    }
    setIsQuickstartRunning(true);
    try {
      await runExcalidrawQuickstart({
        projectId,
        convex,
        createTestSuite: mutations.createTestSuiteMutation,
        createTestCase: mutations.createTestCaseMutation,
        createServerAttachment: createServerAttachmentMutation,
        handleConnect,
        isExcalidrawConnected: connectedServerNames.has(EXCALIDRAW_SERVER_NAME),
        existingQuickstartSuiteId,
        previewedHostId,
      });
    } finally {
      setIsQuickstartRunning(false);
    }
  }, [
    projectId,
    convex,
    handleConnect,
    isQuickstartRunning,
    mutations.createTestSuiteMutation,
    mutations.createTestCaseMutation,
    createServerAttachmentMutation,
    connectedServerNames,
    existingQuickstartSuiteId,
    previewedHostId,
  ]);

  const showQuickstart = Boolean(handleConnect);

  const handleCreateDialogChange = useCallback((open: boolean) => {
    if (!open) {
      navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
    }
  }, []);

  const handleCreateSuite = useCallback(
    async (payload: CreateSuitePayload) => {
      if (!projectId) {
        return;
      }

      try {
        const createdSuite = await mutations.createTestSuiteMutation({
          projectId,
          name: payload.name,
          // environment.servers is left empty: hosts own server selection
          // now, and the runner derives the per-run server set from each
          // attachment's snapshot. Suites with zero attachments are valid
          // skeletons — they just can't run until a host is attached.
          environment: { servers: [] },
          ...(payload.hostAttachments && payload.hostAttachments.length > 0
            ? { hostAttachments: payload.hostAttachments }
            : {}),
          ...(payload.serverAttachmentId
            ? { serverAttachmentId: payload.serverAttachmentId }
            : {}),
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
    [mutations.createTestSuiteMutation, projectId]
  );

  const handleSelectSuite = useCallback((suiteId: string) => {
    navigatePlaygroundEvalsRoute({ type: "suite-overview", suiteId });
  }, []);

  const handleGenerateMore = useCallback(async () => {
    if (!selectedSuite) return;
    const suiteServers = getEffectiveSuiteServers(selectedSuite);
    if (suiteServers.length === 0) return;
    // Scope generation by the suite's saved server attachment when present.
    // Backend uses this to (a) require per-server cases AND at least one
    // cross-server case when the attachment spans ≥2 servers, and (b) put
    // the attachment name on each generated case so failures are
    // attributable to a specific suite scope rather than "any server".
    const suiteAttachment = selectedSuite.serverAttachment;
    const serverAttachment = suiteAttachment
      ? {
          id: suiteAttachment._id,
          name: suiteAttachment.name,
          resolvedServerNames: suiteAttachment.resolvedServerNames,
        }
      : undefined;
    // Per-suite generation config from the "Generate" popover (count, mix,
    // vary-user-styles). Defaults reproduce today's behavior, so the one-click
    // Generate keeps working unchanged when the popover was never touched.
    const generationOptions = toGenerationOptions(
      loadGenerateConfig(selectedSuite._id)
    );
    await handlers.handleGenerateTests(selectedSuite._id, suiteServers, {
      ...(serverAttachment ? { serverAttachment } : {}),
      generationOptions,
    });
  }, [handlers, selectedSuite]);

  const generateState = useMemo(() => {
    const suiteServers = selectedSuite
      ? getEffectiveSuiteServers(selectedSuite)
      : [];
    if (suiteServers.length === 0) {
      return {
        canGenerate: false,
        disabledReason:
          "Attach a client in the suite header before generating cases.",
      };
    }

    const missingServers = suiteServers.filter(
      (serverName) => !connectedServerNames.has(serverName)
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
        disabledReason: `Connect ${missingServers.join(
          ", "
        )} to generate cases for this suite.`,
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
    [directDeleteTestCase, selectedSuiteId, selectedTestId]
  );

  const handleDeleteSuitesBatch = useCallback(
    async (suiteIds: string[]) => {
      const settledDeletes = await Promise.allSettled(
        suiteIds.map((suiteId) => mutations.deleteSuiteMutation({ suiteId }))
      );
      const succeededIds = new Set<string>();
      settledDeletes.forEach((result, i) => {
        if (result.status === "fulfilled") {
          succeededIds.add(suiteIds[i]);
        }
      });
      const failedDeletes = settledDeletes.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );

      if (failedDeletes.length > 0) {
        console.error("Failed to delete some suites:", failedDeletes);
        if (succeededIds.size > 0) {
          toast.error(
            `Deleted ${succeededIds.size} suite${
              succeededIds.size === 1 ? "" : "s"
            }; ${failedDeletes.length} failed.`
          );
        } else {
          toast.error(
            getBillingErrorMessage(
              failedDeletes[0]?.reason,
              "Failed to delete suites"
            )
          );
        }
      } else {
        toast.success(
          suiteIds.length === 1
            ? "Suite deleted"
            : `Deleted ${suiteIds.length} suites`
        );
      }

      if (selectedSuiteId && succeededIds.has(selectedSuiteId)) {
        navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
      }
    },
    [mutations.deleteSuiteMutation, selectedSuiteId]
  );

  const hasDetailRoute =
    selectedSuiteId &&
    (route.type === "suite-overview" ||
      route.type === "run-detail" ||
      route.type === "test-detail" ||
      route.type === "test-edit" ||
      route.type === "suite-edit");

  const selectedTestCase = useMemo(() => {
    if (!selectedTestId) return null;
    return (
      suiteDetails?.testCases.find((tc) => tc._id === selectedTestId) ?? null
    );
  }, [selectedTestId, suiteDetails]);

  const renderPlaygroundBreadcrumb = () => {
    if (!hasDetailRoute || !selectedSuite) return null;
    const suiteCrumbAsLink = route.type !== "suite-overview";
    return (
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="min-w-0 flex-nowrap">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button
                type="button"
                onClick={() => navigatePlaygroundEvalsRoute({ type: "list" })}
                className="inline-flex border-0 bg-transparent p-0 font-medium"
              >
                Suites
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="max-w-[min(200px,28vw)] min-w-0 sm:max-w-[240px]">
            {suiteCrumbAsLink ? (
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  onClick={() =>
                    navigatePlaygroundEvalsRoute({
                      type: "suite-overview",
                      suiteId: selectedSuite._id,
                    })
                  }
                  title={selectedSuite.name}
                  className="inline-flex max-w-full border-0 bg-transparent p-0 font-medium truncate"
                >
                  {selectedSuite.name}
                </button>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage
                className="truncate font-medium"
                title={selectedSuite.name}
              >
                {selectedSuite.name}
              </BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {route.type === "run-detail" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="truncate font-medium">
                  Run {formatRunId(route.runId)}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
          {route.type === "test-detail" || route.type === "test-edit" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="max-w-[min(220px,32vw)] min-w-0">
                <BreadcrumbPage
                  className="truncate font-medium"
                  title={selectedTestCase?.title ?? "Case"}
                >
                  {selectedTestCase?.title ?? "Case"}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
          {route.type === "suite-edit" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="truncate font-medium">
                  Settings
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
    );
  };

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
        <EvalsEmptyHero
          onCreateSuite={handleOpenCreateSuite}
          onQuickstart={() => void handleExcalidrawQuickstart()}
          isQuickstartRunning={isQuickstartRunning}
          showQuickstart={showQuickstart}
        />
      );
    }

    if (hasDetailRoute) {
      const breadcrumb = renderPlaygroundBreadcrumb();
      return (
        <div className="flex h-full min-h-0 flex-col">
          {breadcrumb ? (
            <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                {breadcrumb}
              </div>
            </div>
          ) : null}
          {queries.isSuiteDetailsLoading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <p className="mt-4 text-sm text-muted-foreground">
                  Loading suite data...
                </p>
              </div>
            </div>
          ) : (
            renderSuiteIterationsDetail()
          )}
        </div>
      );
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
          runAllDisabledReason={evalRunsDisabledReason}
          onEditSuite={playgroundNavigation.toSuiteEdit}
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
          onRerun={handleRerunWithQuota}
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
          projectId={projectId}
          navigation={playgroundNavigation}
          onContinueInChat={onContinueInChat}
          canDeleteRuns={canDeleteRuns}
          hideRunActions
          evalRunsDisabledReason={evalRunsDisabledReason}
          onDeleteTestCasesBatch={handleDeleteTestCasesBatch}
          onRunTestCase={(testCase, opts) => {
            void (async () => {
              const data = await handleRunTestCaseWithQuota(
                selectedSuite,
                testCase,
                {
                  location: "test_cases_overview",
                  iterationOverride: opts?.iterationOverride,
                }
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
                  }
                );
              }
            })();
          }}
          runningTestCaseId={handlers.runningTestCaseId}
          projectServers={projectServers}
        />
      </div>
    );
  };

  const renderPlaygroundBody = () => renderSuitesBrowsePanel();

  return (
    <EvalTabGate
      variant="playground"
      isLoading={isLoading}
      isAuthenticated={isAuthenticated}
      user={user}
      projectId={projectId}
      isDirectGuest={isDirectGuest}
    >
      <>
        <CreateSuiteDialog
          open={route.type === "create"}
          onOpenChange={handleCreateDialogChange}
          onSubmit={handleCreateSuite}
          hostsEnabled={hostsEnabled}
          projectId={projectId}
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
