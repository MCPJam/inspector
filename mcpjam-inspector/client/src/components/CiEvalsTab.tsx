import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Eye, GitBranch, Loader2, Play } from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useSharedAppState } from "@/state/app-state-context";
import { useCiEvalsRoute, navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import { buildEvalsHash } from "@/lib/evals-router";
import { withTestingSurface } from "@/lib/testing-surface";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import {
  aggregateSuite,
  formatRunId,
  groupRunsByCommit,
} from "./evals/helpers";
import { RunIterationsSidebar } from "./evals/run-detail-view";
import { useRunDetailData } from "./evals/use-suite-data";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import {
  CiSuiteListSidebar,
  type SidebarMode,
} from "./evals/ci-suite-list-sidebar";
import { CommitDetailView } from "./evals/commit-detail-view";
import { createCiSuiteNavigation } from "./evals/create-suite-navigation";
import { EvalTabGate } from "./evals/EvalTabGate";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import type { EvalSuite } from "./evals/types";
import {
  SAMPLE_TRACE,
  SAMPLE_TRACE_STARTED_AT_MS,
  SAMPLE_TRACE_VIEWER_MODEL,
} from "./evals/sample-trace-data";
import { SdkEvalQuickstart } from "./evals/sdk-eval-quickstart";
import { TraceViewer } from "./evals/trace-viewer";
import { isExploreSuite } from "./evals/constants";
import { HOSTED_MODE } from "@/lib/config";
interface CiEvalsTabProps {
  convexWorkspaceId: string | null;
}

export function CiEvalsTab({ convexWorkspaceId }: CiEvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const appState = useSharedAppState();
  const route = useCiEvalsRoute();
  const mutations = useEvalMutations();

  const [deletingSuiteId, setDeletingSuiteId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("runs");
  const [hasAutoSwitchedMode, setHasAutoSwitchedMode] = useState(false);
  const [runDetailSidebarSortBy, setRunDetailSidebarSortBy] = useState<
    "model" | "test" | "result"
  >("result");
  const [showSampleTrace, setShowSampleTrace] = useState(false);

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

  const {
    connectedServerNames,
    userMap,
    canDeleteRuns,
    availableModels,
  } = useEvalTabContext({
    isAuthenticated,
    workspaceId: convexWorkspaceId,
  });

  const ciNavigation = useMemo(
    () => createCiSuiteNavigation(route),
    [route],
  );

  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(convexWorkspaceId),
    user: convexWorkspaceId ? user : null,
    selectedSuiteId,
    deletingSuiteId,
    workspaceId: convexWorkspaceId,
    organizationId: null,
  });

  const visibleSuites = useMemo(
    () => queries.sortedSuites.filter((entry) => !isExploreSuite(entry.suite)),
    [queries.sortedSuites],
  );
  const hasVisibleSuites = visibleSuites.length > 0;

  const commitGroups = useMemo(
    () => groupRunsByCommit(visibleSuites),
    [visibleSuites],
  );

  // CI/CD: suite config and tests are defined in code (SDK); close edit URLs.
  useEffect(() => {
    if (route.type === "suite-edit") {
      navigateToCiEvalsRoute(
        { type: "suite-overview", suiteId: route.suiteId },
        { replace: true },
      );
      return;
    }
    if (route.type === "test-edit") {
      navigateToCiEvalsRoute(
        {
          type: "test-detail",
          suiteId: route.suiteId,
          testId: route.testId,
        },
        { replace: true },
      );
    }
  }, [route]);

  // Auto-switch to "By Suite" when all runs are manual (no commit SHAs)
  useEffect(() => {
    if (hasAutoSwitchedMode) return;
    if (HOSTED_MODE && commitGroups.length === 0) {
      setSidebarMode("suites");
      setHasAutoSwitchedMode(true);
      return;
    }
    if (commitGroups.length === 0) return;
    const allManual = commitGroups.every((g) =>
      g.commitSha.startsWith("manual-"),
    );
    if (allManual) {
      setSidebarMode("suites");
      setHasAutoSwitchedMode(true);
    }
  }, [commitGroups, hasAutoSwitchedMode]);

  useEffect(() => {
    if (route.type !== "create") return;
    window.location.hash = withTestingSurface(buildEvalsHash({ type: "list" }));
  }, [route.type]);

  useEffect(() => {
    if (route.type !== "commit-detail" || !route.suite) return;
    navigateToCiEvalsRoute(
      {
        type: "suite-overview",
        suiteId: route.suite,
        fromCommit: route.commitSha,
      },
      { replace: true },
    );
  }, [route]);

  const selectedCommitSha = useMemo(() => {
    if (route.type === "commit-detail") return route.commitSha;
    if (route.type === "suite-overview" && route.fromCommit) {
      return route.fromCommit;
    }
    return null;
  }, [route]);

  const selectedRunIdForSidebar =
    route.type === "run-detail" ? route.runId : null;

  const { caseGroupsForSelectedRun } = useRunDetailData(
    selectedRunIdForSidebar,
    queries.sortedIterations,
    runDetailSidebarSortBy,
  );

  const selectedRunForSidebar = useMemo(() => {
    if (route.type !== "run-detail") return null;
    return (
      queries.runsForSelectedSuite.find((r) => r._id === route.runId) ?? null
    );
  }, [route, queries.runsForSelectedSuite]);

  useEffect(() => {
    if (route.type !== "run-detail") {
      setRunDetailSidebarSortBy("result");
    }
  }, [route.type]);

  const selectedCommitGroup = useMemo(() => {
    if (!selectedCommitSha) return null;
    return commitGroups.find((g) => g.commitSha === selectedCommitSha) ?? null;
  }, [commitGroups, selectedCommitSha]);

  const commitBreadcrumbContext = useMemo(() => {
    if (route.type !== "suite-overview" || !route.fromCommit) return null;
    const group = commitGroups.find((g) => g.commitSha === route.fromCommit);
    const label = group
      ? group.commitSha.startsWith("manual-")
        ? "Manual"
        : group.shortSha
      : route.fromCommit.length > 7
        ? route.fromCommit.slice(0, 7)
        : route.fromCommit;
    return { commitSha: route.fromCommit, label };
  }, [route, commitGroups]);

  const selectedSuiteIdInCommit = useMemo(() => {
    if (route.type === "commit-detail" && route.suite) return route.suite;
    if (
      route.type === "suite-overview" &&
      route.fromCommit &&
      selectedSuiteId
    ) {
      const group = commitGroups.find((g) => g.commitSha === route.fromCommit);
      if (!group) return null;
      const inGroup = group.runs.some((r) => r.suiteId === selectedSuiteId);
      return inGroup ? selectedSuiteId : null;
    }
    return null;
  }, [route, commitGroups, selectedSuiteId]);
  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId) return null;
    return (
      visibleSuites.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [visibleSuites, selectedSuiteId]);

  const selectedSuite = selectedSuiteEntry?.suite ?? null;

  const latestRunBySuiteId = useMemo(
    () =>
      new Map(
        visibleSuites.map((entry) => [
          entry.suite._id,
          entry.latestRun ?? null,
        ]),
      ),
    [visibleSuites],
  );

  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry,
    selectedSuiteId,
    selectedTestId,
    connectedServerNames,
    latestRunBySuiteId,
    evalsNavigationContext: "ci-evals",
  });

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !queries.suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      queries.suiteDetails.testCases,
      queries.activeIterations,
    );
  }, [selectedSuite, queries.suiteDetails, queries.activeIterations]);

  const showCiSuiteDrilldownSidebar = useMemo(
    () =>
      Boolean(
        selectedSuiteId &&
        selectedSuite &&
        route.type !== "list" &&
        route.type !== "create" &&
        route.type !== "commit-detail" &&
        hasVisibleSuites,
      ),
    [selectedSuiteId, selectedSuite, route.type, hasVisibleSuites],
  );

  useEffect(() => {
    if (route.type === "list" || route.type === "create") return;
    if (!selectedSuiteId) return;
    if (queries.isOverviewLoading) return;
    if (!selectedSuiteEntry) {
      navigateToCiEvalsRoute({ type: "list" });
    }
  }, [
    route.type,
    selectedSuiteId,
    queries.isOverviewLoading,
    selectedSuiteEntry,
  ]);

  const handleSelectSuite = useCallback((suiteId: string) => {
    navigateToCiEvalsRoute({ type: "suite-overview", suiteId });
  }, []);

  const handleSelectCommit = useCallback((commitSha: string) => {
    navigateToCiEvalsRoute({ type: "commit-detail", commitSha });
  }, []);

  const handleSelectSuiteInCommit = useCallback(
    (suiteId: string) => {
      const commitSha =
        route.type === "commit-detail"
          ? route.commitSha
          : route.type === "suite-overview" && route.fromCommit
            ? route.fromCommit
            : null;
      if (!commitSha) return;
      navigateToCiEvalsRoute({
        type: "suite-overview",
        suiteId,
        fromCommit: commitSha,
      });
    },
    [route],
  );

  const handleDeleteSuite = useCallback(
    async (suite: EvalSuite) => {
      if (deletingSuiteId) return;

      const confirmed = window.confirm(
        `Delete suite "${suite.name}" and all its runs? This cannot be undone.`,
      );
      if (!confirmed) return;

      setDeletingSuiteId(suite._id);
      try {
        await mutations.deleteSuiteMutation({ suiteId: suite._id });
        toast.success("Suite deleted");

        if (selectedSuiteId === suite._id) {
          navigateToCiEvalsRoute({ type: "list" });
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete suite",
        );
      } finally {
        setDeletingSuiteId(null);
      }
    },
    [deletingSuiteId, mutations.deleteSuiteMutation, selectedSuiteId],
  );

  const handleDeleteRun = useCallback(
    async (runId: string) => {
      if (deletingRunId) return;

      const confirmed = window.confirm(
        "Delete this run and all of its iterations? This cannot be undone.",
      );
      if (!confirmed) return;

      setDeletingRunId(runId);
      try {
        await handlers.directDeleteRun(runId);
        toast.success("Run deleted");

        if (
          route.type === "run-detail" &&
          route.runId === runId &&
          selectedSuiteId
        ) {
          navigateToCiEvalsRoute({
            type: "suite-overview",
            suiteId: selectedSuiteId,
          });
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete run",
        );
      } finally {
        setDeletingRunId(null);
      }
    },
    [deletingRunId, handlers, route, selectedSuiteId],
  );

  const handleCreateTestCase = useCallback(async () => {
    if (!selectedSuiteId) return;
    await handlers.handleCreateTestCase(selectedSuiteId);
  }, [handlers, selectedSuiteId]);

  const handleDuplicateTestCase = useCallback(
    (testCaseId: string) => {
      if (!selectedSuiteId) return;
      handlers.handleDuplicateTestCase(testCaseId, selectedSuiteId);
    },
    [handlers, selectedSuiteId],
  );

  const handleGenerateTests = useCallback(async () => {
    if (!selectedSuiteId || !selectedSuite) return;
    await handlers.handleGenerateTests(
      selectedSuiteId,
      selectedSuite.environment?.servers || [],
    );
  }, [handlers, selectedSuite, selectedSuiteId]);

  const handleCiBreadcrumbToSuiteList = useCallback(() => {
    navigateToCiEvalsRoute({ type: "list" });
  }, []);

  const handleCiBreadcrumbToSuiteOverview = useCallback(() => {
    if (!selectedSuite) return;
    navigateToCiEvalsRoute({
      type: "suite-overview",
      suiteId: selectedSuite._id,
    });
  }, [selectedSuite]);

  const handleCiBreadcrumbToCommit = useCallback(() => {
    if (!commitBreadcrumbContext) return;
    navigateToCiEvalsRoute({
      type: "commit-detail",
      commitSha: commitBreadcrumbContext.commitSha,
    });
  }, [commitBreadcrumbContext]);

  const isRunDetailView = route.type === "run-detail";

  return (
    <EvalTabGate
      variant="ci"
      isLoading={isLoading}
      isAuthenticated={isAuthenticated}
      user={user}
      workspaceId={convexWorkspaceId}
    >
      <>
      <div className="h-full flex flex-col overflow-hidden">
      {showCiSuiteDrilldownSidebar && selectedSuite ? (
        <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList className="min-w-0 flex-nowrap">
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      onClick={handleCiBreadcrumbToSuiteList}
                      className="inline-flex border-0 bg-transparent p-0 font-medium"
                    >
                      Suites
                    </button>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                {commitBreadcrumbContext ? (
                  <>
                    <BreadcrumbItem className="max-w-[min(120px,20vw)] min-w-0">
                      <BreadcrumbLink asChild>
                        <button
                          type="button"
                          onClick={handleCiBreadcrumbToCommit}
                          title="Back to commit"
                          className="inline-flex max-w-full border-0 bg-transparent p-0 font-medium truncate"
                        >
                          {commitBreadcrumbContext.label}
                        </button>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                  </>
                ) : null}
                {route.type === "run-detail" ? (
                  <>
                    <BreadcrumbItem className="max-w-[min(200px,28vw)] min-w-0 sm:max-w-[240px]">
                      <BreadcrumbLink asChild>
                        <button
                          type="button"
                          onClick={handleCiBreadcrumbToSuiteOverview}
                          title={selectedSuite.name}
                          className="inline-flex max-w-full border-0 bg-transparent p-0 font-medium truncate"
                        >
                          {selectedSuite.name}
                        </button>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage className="truncate font-medium">
                        Run {formatRunId(route.runId)}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                ) : (
                  <BreadcrumbItem className="max-w-[min(280px,50vw)] min-w-0">
                    <BreadcrumbPage
                      className="truncate font-medium"
                      title={selectedSuite.name}
                    >
                      {selectedSuite.name}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                )}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </div>
      ) : null}
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 overflow-hidden"
      >
        <ResizablePanel
          defaultSize={28}
          minSize={20}
          maxSize={35}
          className="flex min-h-0 flex-col border-r bg-muted/30"
        >
          {showCiSuiteDrilldownSidebar && route.type === "run-detail" ? (
            <RunIterationsSidebar
              caseGroupsForSelectedRun={caseGroupsForSelectedRun}
              runDetailSortBy={runDetailSidebarSortBy}
              onSortChange={setRunDetailSidebarSortBy}
              selectedIterationId={route.iteration ?? null}
              onSelectIteration={(iterationId) => {
                navigateToCiEvalsRoute({
                  type: "run-detail",
                  suiteId: route.suiteId,
                  runId: route.runId,
                  iteration: iterationId,
                });
              }}
              runForOverview={selectedRunForSidebar}
              onOpenRunInsights={
                route.type === "run-detail"
                  ? () =>
                      navigateToCiEvalsRoute({
                        type: "run-detail",
                        suiteId: route.suiteId,
                        runId: route.runId,
                        insightsFocus: true,
                      })
                  : undefined
              }
              runInsightsSelected={
                route.type === "run-detail"
                  ? Boolean(route.insightsFocus && !route.iteration)
                  : false
              }
            />
          ) : (
            <CiSuiteListSidebar
              suites={visibleSuites}
              selectedSuiteId={selectedSuiteId}
              onSelectSuite={handleSelectSuite}
              isLoading={queries.isOverviewLoading}
              sidebarMode={sidebarMode}
              onSidebarModeChange={setSidebarMode}
              commitGroups={commitGroups}
              selectedCommitSha={selectedCommitSha}
              onSelectCommit={handleSelectCommit}
              selectedSuiteIdInCommit={selectedSuiteIdInCommit}
              onSelectSuiteInCommit={handleSelectSuiteInCommit}
            />
          )}
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize={72}
          minSize={route.type === "run-detail" ? 42 : 15}
          className="flex flex-col overflow-hidden"
        >
          {route.type === "create" ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : route.type === "commit-detail" && selectedCommitGroup ? (
            <CommitDetailView commitGroup={selectedCommitGroup} route={route} />
          ) : !hasVisibleSuites ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-6 py-8 pb-12">
                <div className="mb-6 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
                    <GitBranch className="h-6 w-6 text-primary" />
                  </div>
                  <h2 className="mb-1 text-lg font-semibold tracking-tight text-foreground">
                    Run your first eval from code
                  </h2>
                  <p className="mb-4 text-sm text-muted-foreground">
                    See what a completed eval looks like before you start.
                  </p>
                  <motion.button
                    type="button"
                    onClick={() => setShowSampleTrace(true)}
                    className="group relative mx-auto inline-flex items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/5 px-5 py-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-primary/10"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2, duration: 0.4, ease: "easeOut" }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <motion.span
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"
                      animate={{ scale: [1, 1.08, 1] }}
                      transition={{
                        duration: 2.4,
                        repeat: Infinity,
                        ease: "easeInOut",
                      }}
                    >
                      <Play className="size-4 fill-current" />
                    </motion.span>
                    <span className="flex flex-col items-start">
                      <span>View sample trace</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        Timeline, chat &amp; raw data
                      </span>
                    </span>
                    <Eye className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
                  </motion.button>
                </div>
                <SdkEvalQuickstart workspaceId={convexWorkspaceId} />
              </div>
            </div>
          ) : route.type === "list" || !selectedSuite ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="mx-auto max-w-md p-6 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <GitBranch className="h-7 w-7 text-muted-foreground" />
                </div>
                <h2 className="mb-2 text-lg font-semibold text-foreground">
                  Select a suite or commit
                </h2>
                <p className="text-sm text-muted-foreground">
                  Choose a suite to inspect regressions and failures, or switch
                  to commits when you want a run-by-run timeline.
                </p>
              </div>
            </div>
          ) : queries.isSuiteDetailsLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                <p className="mt-4 text-muted-foreground">
                  Loading suite data...
                </p>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "flex h-full min-h-0 flex-1 flex-col overflow-hidden",
                isRunDetailView ? "px-4 pb-3 pt-3" : "px-6 pb-6 pt-6",
              )}
            >
              <SuiteIterationsView
                suite={selectedSuite}
                cases={queries.suiteDetails?.testCases || []}
                iterations={queries.activeIterations}
                allIterations={queries.sortedIterations}
                runs={queries.runsForSelectedSuite}
                runsLoading={queries.isSuiteRunsLoading}
                aggregate={suiteAggregate}
                runDetailSortByOverride={
                  isRunDetailView ? runDetailSidebarSortBy : undefined
                }
                onRunDetailSortByChange={
                  isRunDetailView ? setRunDetailSidebarSortBy : undefined
                }
                omitRunIterationList={isRunDetailView}
                onRerun={handlers.handleRerun}
                onReplayRun={handlers.handleReplayRun}
                onCancelRun={handlers.handleCancelRun}
                onDelete={handleDeleteSuite}
                onDeleteRun={handleDeleteRun}
                onDirectDeleteRun={handlers.directDeleteRun}
                connectedServerNames={connectedServerNames}
                rerunningSuiteId={handlers.rerunningSuiteId}
                replayingRunId={handlers.replayingRunId}
                cancellingRunId={handlers.cancellingRunId}
                deletingSuiteId={deletingSuiteId}
                deletingRunId={deletingRunId}
                availableModels={availableModels}
                route={route}
                userMap={userMap}
                navigation={ciNavigation}
                canDeleteRuns={canDeleteRuns}
                readOnlyConfig
                omitSuiteHeader
              />
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>

      <Dialog open={showSampleTrace} onOpenChange={setShowSampleTrace}>
        <DialogContent className="flex max-h-[85vh] max-w-5xl flex-col gap-4 overflow-hidden sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Sample trace</DialogTitle>
            <DialogDescription>
              Example of an eval iteration with tool calls and timing — same
              tabs as a real run (Timeline, Chat, Raw).
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TraceViewer
              trace={SAMPLE_TRACE}
              model={SAMPLE_TRACE_VIEWER_MODEL}
              traceStartedAtMs={SAMPLE_TRACE_STARTED_AT_MS}
              chromeDensity="compact"
            />
          </div>
        </DialogContent>
      </Dialog>
      </>
    </EvalTabGate>
  );
}
