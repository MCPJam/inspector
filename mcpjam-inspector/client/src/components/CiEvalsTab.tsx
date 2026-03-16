import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useSharedAppState } from "@/state/app-state-context";
import { useCiEvalsRoute, navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
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
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import type { EvalSuite } from "./evals/types";

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

  const selectedSuiteId =
    route.type === "suite-overview" ||
    route.type === "run-detail" ||
    route.type === "test-detail"
      ? route.suiteId
      : null;
  const selectedTestId = route.type === "test-detail" ? route.testId : null;

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
  });

  const sdkSuites = useMemo(
    () => queries.sortedSuites.filter((entry) => entry.suite.source === "sdk"),
    [queries.sortedSuites],
  );

  const commitGroups = useMemo(() => groupRunsByCommit(sdkSuites), [sdkSuites]);

  // Auto-switch to "By Suite" when all runs are manual (no commit SHAs)
  useEffect(() => {
    if (hasAutoSwitchedMode) return;
    if (commitGroups.length === 0) return;
    const allManual = commitGroups.every((g) => g.commitSha.startsWith("manual-"));
    if (allManual) {
      setSidebarMode("suites");
      setHasAutoSwitchedMode(true);
    }
  }, [commitGroups, hasAutoSwitchedMode]);

  const selectedCommitSha =
    route.type === "commit-detail" ? route.commitSha : null;

  const selectedCommitGroup = useMemo(() => {
    if (!selectedCommitSha) return null;
    return commitGroups.find((g) => g.commitSha === selectedCommitSha) ?? null;
  }, [commitGroups, selectedCommitSha]);
  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId) return null;
    return (
      sdkSuites.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [sdkSuites, selectedSuiteId]);

  const selectedSuite = selectedSuiteEntry?.suite ?? null;

  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry,
    selectedSuiteId,
    selectedTestId,
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
    if (route.type === "list") return;
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
            view: "runs",
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
            suites={sdkSuites}
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
          {route.type === "commit-detail" && selectedCommitGroup ? (
            <CommitDetailView
              commitGroup={selectedCommitGroup}
              route={route}
            />
          ) : sdkSuites.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-md mx-auto p-8">
                <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                  <GitBranch className="h-10 w-10 text-muted-foreground" />
                </div>
                <h2 className="text-2xl font-semibold text-foreground mb-2">
                  No CI runs yet
                </h2>
                <p className="text-sm text-muted-foreground">
                  Report eval results from your SDK or CI pipeline to see runs
                  here.
                </p>
              </div>
            </div>
          ) : route.type === "list" || !selectedSuite ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-md mx-auto p-8">
                <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                  <GitBranch className="h-10 w-10 text-muted-foreground" />
                </div>
                <h2 className="text-2xl font-semibold text-foreground mb-2">
                  Select a suite
                </h2>
                <p className="text-sm text-muted-foreground">
                  Choose a CI suite or commit from the sidebar to inspect runs
                  and test iterations.
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
                onCancelRun={handlers.handleCancelRun}
                onDeleteSuite={handleDeleteSuite}
                onDeleteRun={handleDeleteRun}
                onDirectDeleteRun={handlers.directDeleteRun}
                connectedServerNames={connectedServerNames}
                rerunningSuiteId={handlers.rerunningSuiteId}
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
