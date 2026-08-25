import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { GitBranch, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
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
} from "@mcpjam/design-system/dialog";
import { cn } from "@/lib/utils";
import {
  buildEvalsRunsPath,
  buildEvalsPath,
  navigateApp,
} from "@/lib/app-navigation";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useEvalsRunsRouteFromUrl } from "@/lib/eval-route-url";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import {
  aggregateSuite,
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
import { ProjectRunsTable } from "./evals/project-runs-table";
import { createCiSuiteNavigation } from "./evals/create-suite-navigation";
import { EvalTabGate } from "./evals/EvalTabGate";
import { EvalsHeader, type EvalLandingView } from "./evals/evals-header";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import type { EvalSuite } from "./evals/types";
import {
  SAMPLE_TRACE,
  SAMPLE_TRACE_PREVIEW_IMAGE_URL,
  SAMPLE_TRACE_STARTED_AT_MS,
  SAMPLE_TRACE_VIEWER_MODEL,
} from "./evals/sample-trace-data";
import { SdkEvalQuickstart } from "./evals/sdk-eval-quickstart";
import { TraceViewer } from "./evals/trace-viewer";
import { isExploreSuite } from "./evals/constants";
import { HOSTED_MODE } from "@/lib/config";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { buildCiEvalsSnapshot } from "@/lib/webmcp/review-surface-snapshots";
import { useProjectServers } from "@/hooks/useViews";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { EvalRoute } from "@/lib/eval-route-types";

function navigateToCiEvalsPath(
  route: EvalRoute,
  options?: { replace?: boolean },
) {
  navigateApp(buildEvalsRunsPath(route), options);
}

interface CiEvalsTabProps {
  convexProjectId: string | null;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
}

export function CiEvalsTab({
  convexProjectId,
  ensureServersReady,
}: CiEvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const route = useEvalsRunsRouteFromUrl();
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
    organizationId,
    connectedServerNames,
    userMap,
    canDeleteArtifact,
    canDeleteRuns,
    availableModels,
  } = useEvalTabContext({
    isAuthenticated,
    projectId: convexProjectId,
  });

  const { servers: ciProjectServers = [] } = useProjectServers({
    isAuthenticated,
    projectId: convexProjectId,
  });

  const ciNavigation = useMemo(() => createCiSuiteNavigation(route), [route]);

  const handleOpenCreateSuite = useCallback(() => {
    navigateApp(buildEvalsPath({ type: "create" }));
  }, []);

  const handleLandingViewChange = useCallback((view: EvalLandingView) => {
    if (view === "suites") {
      navigateApp(buildEvalsPath({ type: "list" }));
    }
  }, []);

  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(convexProjectId),
    selectedSuiteId,
    deletingSuiteId,
    projectId: convexProjectId,
    organizationId: null,
  });

  // The CI tab is a lens over CI-active suites: SDK-registered ones (even
  // before their first run) plus any suite CI has actually reported into
  // (suite.lastSdkRunAt is the durable server-side signal — backfilled, so
  // mixed suites whose sdk runs fell out of the recent-runs window still
  // qualify). Playground-only suites live in the Evaluate tab.
  const visibleSuites = useMemo(
    () =>
      queries.sortedSuites.filter(
        (entry) =>
          !isExploreSuite(entry.suite) &&
          (entry.suite.source === "sdk" || entry.suite.lastSdkRunAt != null),
      ),
    [queries.sortedSuites],
  );
  const hasVisibleSuites = visibleSuites.length > 0;
  // `visibleSuites` is intentionally CI-only, but the project-wide runs table
  // includes playground/API/scheduled/GitHub runs too. Keep the first-run NUX
  // only for genuinely empty projects; otherwise a project with runs in an
  // excluded suite would hide the only surface that can show those runs.
  const hasProjectRuns = queries.sortedSuites.some(
    (entry) => entry.latestRun !== null || entry.recentRuns.length > 0,
  );

  // Commit rail groups CI runs only — playground runs on mixed suites would
  // otherwise flood it as "manual" pseudo-commit groups.
  const commitGroups = useMemo(
    () =>
      groupRunsByCommit(
        visibleSuites.map((entry) => ({
          ...entry,
          recentRuns: entry.recentRuns.filter((run) => run.source === "sdk"),
        })),
      ),
    [visibleSuites],
  );

  // CI/CD: suite config and tests are defined in code (SDK); close edit URLs.
  useEffect(() => {
    if (route.type === "suite-edit") {
      navigateToCiEvalsPath(
        { type: "suite-overview", suiteId: route.suiteId },
        { replace: true },
      );
      return;
    }
    if (route.type === "test-edit") {
      navigateToCiEvalsPath(
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
    navigateApp("/evals");
  }, [route.type]);

  useEffect(() => {
    if (route.type !== "commit-detail" || !route.suite) return;
    navigateToCiEvalsPath(
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
    // Without this the Runs lens can't open the upgrade wall on a server-side
    // cap rejection and falls back to the dead-end toast.
    organizationId,
    connectedServerNames,
    ensureServersReady,
    latestRunBySuiteId,
    evalsNavigationContext: "ci-evals",
    projectServers: ciProjectServers,
    availableModels,
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
      navigateToCiEvalsPath({ type: "list" });
    }
  }, [
    route.type,
    selectedSuiteId,
    queries.isOverviewLoading,
    selectedSuiteEntry,
  ]);

  const handleSelectSuite = useCallback((suiteId: string) => {
    navigateToCiEvalsPath({ type: "suite-overview", suiteId });
  }, []);

  /**
   * Open a run picked from the all-runs table.
   *
   * The table lists EVERY run in the project, but this tab's drilldown only
   * resolves CI-visible suites — and the guard below
   * (`!selectedSuiteEntry` → back to `list`) would bounce a playground suite's
   * run straight back here, making the row click look broken. Send those to
   * the Evaluate tab instead, which is that suite's actual home.
   */
  const handleSelectRunFromAllRuns = useCallback(
    ({ suiteId, runId }: { suiteId: string; runId: string }) => {
      const target = { type: "run-detail", suiteId, runId } as const;
      const isCiVisible = visibleSuites.some(
        (entry) => entry.suite._id === suiteId,
      );
      navigateApp(
        isCiVisible ? buildEvalsRunsPath(target) : buildEvalsPath(target)
      );
    },
    [visibleSuites],
  );

  const handleSelectCommit = useCallback((commitSha: string) => {
    navigateToCiEvalsPath({ type: "commit-detail", commitSha });
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
      navigateToCiEvalsPath({
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
          navigateToCiEvalsPath({ type: "list" });
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
          navigateToCiEvalsPath({
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

  const handleCiBreadcrumbToSuiteList = useCallback(() => {
    navigateToCiEvalsPath({ type: "list" });
  }, []);

  const isRunDetailView = route.type === "run-detail";

  // Agent bridge: SNAPSHOT-ONLY (no tools). CI Evals is a read-only review of
  // results CI already produced (agentTools kind "none"); the agent may OBSERVE
  // it. This bridge lives in CiEvalsTab's OWN component with the literal
  // "ci-evals" id — NEVER in the shared eval hooks EvalsTab also uses, which
  // would register under the wrong surface. Redacted STATE only: suite names,
  // commit SHAs, and pass/fail COUNTS — never a test's prompt or model output.
  useSurfaceAgentBridge({
    surfaceId: "evals",
    snapshot: () =>
      buildCiEvalsSnapshot({
        routeType: route.type,
        sidebarMode,
        selectedSuiteId,
        selectedSuiteName: selectedSuite?.name ?? null,
        selectedCommitSha,
        suites: visibleSuites.map((entry) => ({
          name: entry.suite.name,
          source: entry.suite.source ?? "unknown",
          latestResult:
            entry.latestRun?.result ?? entry.latestRun?.status ?? null,
        })),
        commits: commitGroups.map((group) => ({
          shortSha: group.shortSha,
          branch: group.branch,
          status: group.status,
          total: group.summary.total,
          passed: group.summary.passed,
          failed: group.summary.failed,
          running: group.summary.running,
        })),
      }),
  });

  return (
    <EvalTabGate
      variant="ci"
      isLoading={isLoading}
      isAuthenticated={isAuthenticated}
      user={user}
      projectId={convexProjectId}
      header={
        <EvalsHeader
          onCreateSuite={
            route.type === "list" ? handleOpenCreateSuite : undefined
          }
          onEvaluateClick={handleCiBreadcrumbToSuiteList}
          isDetail={route.type !== "list"}
          landingView={route.type === "list" ? "runs" : undefined}
          onLandingViewChange={
            route.type === "list" ? handleLandingViewChange : undefined
          }
        >
          {showCiSuiteDrilldownSidebar && selectedSuite
            ? selectedSuite.name
            : null}
        </EvalsHeader>
      }
    >
      <>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                  selectedTestCaseId={route.testCaseId ?? null}
                  onSelectTestCase={(group) => {
                    if (!group.testCaseId) return;
                    navigateToCiEvalsPath({
                      type: "run-detail",
                      suiteId: route.suiteId,
                      runId: route.runId,
                      testCaseId: group.testCaseId,
                    });
                  }}
                  selectedIterationId={route.iteration ?? null}
                  onSelectIteration={(iterationId) => {
                    navigateToCiEvalsPath({
                      type: "run-detail",
                      suiteId: route.suiteId,
                      runId: route.runId,
                      iteration: iterationId,
                      testCaseId: route.testCaseId,
                    });
                  }}
                  runForOverview={selectedRunForSidebar}
                  onOpenRunInsights={
                    route.type === "run-detail"
                      ? () =>
                          navigateToCiEvalsPath({
                            type: "run-detail",
                            suiteId: route.suiteId,
                            runId: route.runId,
                            insightsFocus: true,
                          })
                      : undefined
                  }
                  runInsightsSelected={
                    route.type === "run-detail"
                      ? Boolean(
                          route.insightsFocus &&
                          !route.iteration &&
                          !route.testCaseId,
                        )
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
              ) : queries.isOverviewLoading ? (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                    <p className="mt-4 text-muted-foreground">
                      Loading runs...
                    </p>
                  </div>
                </div>
              ) : !hasVisibleSuites && !hasProjectRuns ? (
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                  <div className="mx-auto w-full max-w-4xl px-6 py-8 pb-12">
                    <div className="mb-6 flex gap-6 items-center rounded-xl border border-border bg-muted/60 px-6 py-5">
                      <div className="w-2/5 shrink-0 space-y-2">
                        <h2 className="text-3xl font-bold tracking-tight text-foreground">
                          <GitBranch className="inline-block h-7 w-7 text-primary mr-2 mb-1" />
                          Run your first eval
                        </h2>
                        <p className="text-base text-muted-foreground leading-relaxed">
                          Follow the steps below to connect to an MCP server,
                          run an eval, and see your first run appear in MCPJam.
                        </p>
                      </div>
                      <div
                        className="flex-1 relative aspect-[16/9] overflow-hidden rounded-xl group cursor-pointer"
                        onClick={() => setShowSampleTrace(true)}
                      >
                        <img
                          src={SAMPLE_TRACE_PREVIEW_IMAGE_URL}
                          alt="Sample eval trace preview"
                          className="w-full h-full object-cover object-top"
                        />
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-black/30 to-black/20 group-hover:from-black/65 group-hover:via-black/35 group-hover:to-black/25 transition-colors" />
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <div className="rounded-md border border-white/20 bg-white/95 px-4 py-2.5 text-sm font-semibold text-foreground shadow-lg transition-colors group-hover:bg-white">
                            View sample trace
                          </div>
                        </div>
                        <div className="pointer-events-none absolute bottom-3 left-4 max-w-[min(100%,18rem)]">
                          <p className="text-white/80 text-xs leading-snug">
                            See what a completed eval looks like before you
                            start.
                          </p>
                        </div>
                      </div>
                    </div>
                    <SdkEvalQuickstart projectId={convexProjectId} />
                  </div>
                </div>
              ) : route.type === "commit-detail" && selectedCommitGroup ? (
                <CommitDetailView
                  commitGroup={selectedCommitGroup}
                  route={route}
                />
              ) : (route.type === "list" || !selectedSuite) &&
                shouldQueryProjectId(convexProjectId) ? (
                // Both disjuncts land here on purpose. `list` is the landing
                // route; `!selectedSuite` is an unresolved or deleted suite id
                // in the URL, and the all-runs table is a better answer to
                // that than an empty "select something" placeholder — the run
                // the reader was after is still in this list.
                //
                // Gated on `shouldQueryProjectId`, not truthiness: a local or
                // placeholder project id would mount a `listProjectRuns`
                // subscription Convex cannot resolve.
                <ProjectRunsTable
                  projectId={convexProjectId as string}
                  onSelectRun={handleSelectRunFromAllRuns}
                />
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
                      Choose a suite to inspect regressions and failures, or
                      switch to commits when you want a run-by-run timeline.
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
                    canDeleteSuite={canDeleteArtifact(selectedSuite?.createdBy)}
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
                    canDeleteRun={(run) => canDeleteArtifact(run.createdBy)}
                    readOnlyConfig
                    omitSuiteHeader
                    onRunTestCase={
                      selectedSuite
                        ? (tc, opts) => {
                            void (async () => {
                              const data = await handlers.handleRunTestCase(
                                selectedSuite,
                                tc,
                                {
                                  location: "test_cases_overview",
                                  iterationOverride: opts?.iterationOverride,
                                },
                              );
                              const iterationId = (data?.iteration?._id ??
                                data?.runs?.find(
                                  (run: any) => run?.iteration?._id,
                                )?.iteration?._id) as string | undefined;
                              if (iterationId) {
                                ciNavigation.toTestDetail(
                                  selectedSuite._id,
                                  tc._id,
                                  iterationId,
                                );
                              }
                            })();
                          }
                        : undefined
                    }
                    runningTestCaseId={handlers.runningTestCaseId}
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
