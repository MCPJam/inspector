import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { GitBranch, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useSharedAppState } from "@/state/app-state-context";
import { useCiEvalsRoute, navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import { buildEvalsHash } from "@/lib/evals-router";
import { withTestingSurface, type TestingSurface } from "@/lib/testing-surface";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";
import { aggregateSuite, groupRunsByCommit } from "./evals/helpers";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import {
  CiSuiteListSidebar,
  type SidebarMode,
} from "./evals/ci-suite-list-sidebar";
import { CiSuiteDetail } from "./evals/ci-suite-detail";
import { CommitDetailView } from "./evals/commit-detail-view";
import { HostedCiSuiteWorkspaceDetail } from "./evals/hosted-ci-suite-workspace-detail";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import type { EvalSuite } from "./evals/types";
import { HOSTED_MODE } from "@/lib/config";
import { TestingSurfaceNav } from "./evals/testing-surface-nav";

interface CiEvalsTabProps {
  convexWorkspaceId: string | null;
}

const EXPLORE_TAG = "explore";

function isExploreSuite(suite: EvalSuite): boolean {
  return suite.tags?.includes(EXPLORE_TAG) === true;
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
  const { availableModels } = useAvailableEvalModels();

  const connectedServerNames = useMemo(
    () =>
      new Set(
        Object.entries(appState.servers)
          .filter(([, server]) => server.connectionStatus === "connected")
          .map(([name]) => name),
      ),
    [appState.servers],
  );

  const { members } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: convexWorkspaceId,
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

  // Sidebar defaults to Runs; send empty workspaces to Explore instead of an empty Runs shell.
  useEffect(() => {
    if (!isAuthenticated || !convexWorkspaceId) return;
    if (queries.isOverviewLoading) return;
    if (hasVisibleSuites) return;
    if (route.type !== "list") return;
    const exploreHash = withTestingSurface(buildEvalsHash({ type: "list" }));
    if (window.location.hash === exploreHash) return;
    window.location.hash = exploreHash;
  }, [
    convexWorkspaceId,
    hasVisibleSuites,
    isAuthenticated,
    queries.isOverviewLoading,
    route.type,
  ]);

  const commitGroups = useMemo(
    () => groupRunsByCommit(visibleSuites),
    [visibleSuites],
  );

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

  const selectedCommitSha =
    route.type === "commit-detail" ? route.commitSha : null;

  const selectedCommitGroup = useMemo(() => {
    if (!selectedCommitSha) return null;
    return commitGroups.find((g) => g.commitSha === selectedCommitSha) ?? null;
  }, [commitGroups, selectedCommitSha]);
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

  const handleSurfaceChange = useCallback((nextSurface: TestingSurface) => {
    if (nextSurface === "runs") {
      return;
    }
    window.location.hash = withTestingSurface(buildEvalsHash({ type: "list" }));
  }, []);

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

  if (!isAuthenticated || !user) {
    return (
      <div className="p-6">
        <EmptyState
          icon={GitBranch}
          title="Sign in to view CI runs"
          description="Create an account or sign in to view SDK-ingested evaluation runs."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  if (!convexWorkspaceId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={GitBranch}
          title="Select a workspace"
          description="Choose a workspace to view shared CI evaluation runs."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <TestingSurfaceNav value="runs" onChange={handleSurfaceChange} />
            <p className="min-w-0 text-sm text-muted-foreground">
              Saved suites and CI-backed run history
            </p>
          </div>
        </div>
      </div>
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 overflow-hidden"
      >
        <ResizablePanel
          defaultSize={24}
          minSize={20}
          maxSize={35}
          className="border-r bg-muted/30 flex flex-col"
        >
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
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize={70}
          className="flex flex-col overflow-hidden"
        >
          {route.type === "create" ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : route.type === "commit-detail" && selectedCommitGroup ? (
            <CommitDetailView commitGroup={selectedCommitGroup} route={route} />
          ) : !hasVisibleSuites ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="mx-auto max-w-md p-6 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <GitBranch className="h-7 w-7 text-muted-foreground" />
                </div>
                <h2 className="mb-2 text-lg font-semibold text-foreground">
                  No runs yet
                </h2>
                <p className="text-sm text-muted-foreground">
                  Switch to{" "}
                  <span className="font-medium text-foreground">Explore</span>{" "}
                  in the Testing header to create and save suites. Re-run a
                  saved suite to see manual and CI-backed history here.
                </p>
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
          ) : HOSTED_MODE ? (
            <HostedCiSuiteWorkspaceDetail
              suite={selectedSuite}
              cases={queries.suiteDetails?.testCases || []}
              iterations={queries.activeIterations}
              allIterations={queries.sortedIterations}
              runs={queries.runsForSelectedSuite}
              runsLoading={queries.isSuiteRunsLoading}
              aggregate={suiteAggregate}
              route={route}
              connectedServerNames={connectedServerNames}
              availableModels={availableModels}
              onRerun={handlers.handleRerun}
              onReplayRun={handlers.handleReplayRun}
              onCancelRun={handlers.handleCancelRun}
              onDelete={handleDeleteSuite}
              onDeleteRun={handleDeleteRun}
              onDirectDeleteRun={handlers.directDeleteRun}
              rerunningSuiteId={handlers.rerunningSuiteId}
              replayingRunId={handlers.replayingRunId}
              cancellingRunId={handlers.cancellingRunId}
              deletingSuiteId={deletingSuiteId}
              deletingRunId={deletingRunId}
              userMap={userMap}
            />
          ) : (
            <div
              className={`flex-1 px-6 pb-6 pt-6 ${route.type === "run-detail" ? "overflow-hidden flex flex-col" : "overflow-y-auto"}`}
            >
              <CiSuiteDetail
                suite={selectedSuite}
                cases={queries.suiteDetails?.testCases || []}
                iterations={queries.activeIterations}
                allIterations={queries.sortedIterations}
                runs={queries.runsForSelectedSuite}
                runsLoading={queries.isSuiteRunsLoading}
                aggregate={suiteAggregate}
                onRerun={handlers.handleRerun}
                onReplayRun={handlers.handleReplayRun}
                onCancelRun={handlers.handleCancelRun}
                onDeleteSuite={handleDeleteSuite}
                onDeleteRun={handleDeleteRun}
                onDirectDeleteRun={handlers.directDeleteRun}
                connectedServerNames={connectedServerNames}
                rerunningSuiteId={handlers.rerunningSuiteId}
                replayingRunId={handlers.replayingRunId}
                cancellingRunId={handlers.cancellingRunId}
                deletingSuiteId={deletingSuiteId}
                deletingRunId={deletingRunId}
                route={route}
                userMap={userMap}
              />
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
