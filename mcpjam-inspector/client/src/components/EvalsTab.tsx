import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvex, useConvexAuth, useMutation } from "convex/react";
import {
  ArrowRight,
  FlaskConical,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildEvalsHash,
  navigateToEvalsRoute,
  useEvalsRoute,
  type EvalsRoute,
} from "@/lib/evals-router";
import { navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import {
  readTestingSurfaceFromHash,
  withTestingSurface,
  type TestingSurface,
} from "@/lib/testing-surface";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";
import { aggregateSuite, sortExploreCasesBySignal } from "./evals/helpers";
import { SuiteIterationsView, type SuiteNavigation } from "./evals/suite-iterations-view";
import { EvalRunner } from "./evals/eval-runner";
import { TestCaseListSidebar } from "./evals/TestCaseListSidebar";
import { TestingShellHeader } from "./evals/testing-shell-header";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { useSharedAppState } from "@/state/app-state-context";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { EvalCase, EvalSuite } from "./evals/types";

interface EvalsTabProps {
  selectedServer?: string;
  workspaceId?: string | null;
}

const EXPLORE_TAG = "explore";
const EMPTY_CASES: EvalCase[] = [];

function isExploreSuite(suite: EvalSuite): boolean {
  return suite.tags?.includes(EXPLORE_TAG) === true;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "No runs yet";
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function buildSuitesNavigation(): SuiteNavigation {
  const toSurfaceHash = (route: EvalsRoute) =>
    withTestingSurface(buildEvalsHash(route), "suites");

  return {
    toSuiteOverview: (suiteId, view) => {
      window.location.hash = toSurfaceHash({
        type: "suite-overview",
        suiteId,
        view,
      });
    },
    toRunDetail: (suiteId, runId, iteration) => {
      window.location.hash = toSurfaceHash({
        type: "run-detail",
        suiteId,
        runId,
        iteration,
      });
    },
    toTestDetail: (suiteId, testId, iteration) => {
      window.location.hash = toSurfaceHash({
        type: "test-detail",
        suiteId,
        testId,
        iteration,
      });
    },
    toTestEdit: (suiteId, testId) => {
      window.location.hash = toSurfaceHash({
        type: "test-edit",
        suiteId,
        testId,
      });
    },
    toSuiteEdit: (suiteId) => {
      window.location.hash = toSurfaceHash({
        type: "suite-edit",
        suiteId,
      });
    },
  };
}

export function EvalsTab({ selectedServer, workspaceId }: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const route = useEvalsRoute();
  const convex = useConvex();
  const appState = useSharedAppState();
  const ciEvalsEnabled = useFeatureFlagEnabled("ci-evals-enabled");
  const { availableModels } = useAvailableEvalModels();
  const updateSuiteMutation = useMutation("testSuites:updateTestSuite" as any);
  const updateTestCaseMutation = useMutation("testSuites:updateTestCase" as any);
  const mutations = useEvalMutations();

  const [surface, setSurface] = useState<TestingSurface>(() =>
    readTestingSurfaceFromHash(window.location.hash),
  );
  const [isPreparingExplore, setIsPreparingExplore] = useState(false);
  const [saveModalSelectedIds, setSaveModalSelectedIds] = useState<string[]>(
    [],
  );
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [suiteNameDraft, setSuiteNameDraft] = useState("");
  const [isSavingSuite, setIsSavingSuite] = useState(false);
  const [suiteForCiSetup, setSuiteForCiSetup] = useState<EvalSuite | null>(
    null,
  );

  const initializedExploreRef = useRef<Set<string>>(new Set());
  const generatedExploreSuiteRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const applyHash = () => {
      setSurface(readTestingSurfaceFromHash(window.location.hash));
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;
  const selectedSuiteIdFromRoute =
    route.type === "suite-overview" ||
    route.type === "run-detail" ||
    route.type === "test-detail" ||
    route.type === "test-edit" ||
    route.type === "suite-edit"
      ? route.suiteId
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

  const { members } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: workspaceId ?? null,
  });

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

  const savedSuiteEntries = useMemo(
    () =>
      manualSuiteEntries.filter(
        (entry) =>
          !isExploreSuite(entry.suite) &&
          entry.suite.environment?.servers?.length,
      ),
    [manualSuiteEntries],
  );

  const savedSuiteEntry =
    surface === "suites" && selectedSuiteIdFromRoute
      ? (savedSuiteEntries.find(
          (entry) => entry.suite._id === selectedSuiteIdFromRoute,
        ) ?? null)
      : null;

  const selectedSuiteId =
    surface === "explore"
      ? exploreSuiteEntry?.suite._id ?? null
      : selectedSuiteIdFromRoute;

  const activeSuiteEntry =
    surface === "explore" ? exploreSuiteEntry : savedSuiteEntry;

  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry: activeSuiteEntry,
    selectedSuiteId,
    selectedTestId,
    workspaceId: workspaceId ?? null,
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
    return aggregateSuite(selectedSuite, suiteDetails.testCases, activeIterations);
  }, [selectedSuite, suiteDetails, activeIterations]);

  const exploreSuite = surface === "explore" ? selectedSuite : null;
  const exploreCases =
    surface === "explore" ? (suiteDetails?.testCases ?? EMPTY_CASES) : EMPTY_CASES;

  useEffect(() => {
    if (!selectedServer || !isServerConnected || !workspaceId || !isAuthenticated) {
      return;
    }
    if (surface !== "explore" || exploreSuiteEntry) {
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
            tags: [EXPLORE_TAG],
          });
        }
      } catch (error) {
        initializedExploreRef.current.delete(selectedServer);
        toast.error(
          getBillingErrorMessage(error, "Failed to create the Explore workspace"),
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
    surface,
    updateSuiteMutation,
    workspaceId,
  ]);

  useEffect(() => {
    if (
      surface !== "explore" ||
      !exploreSuite ||
      !selectedServer ||
      !isServerConnected ||
      queries.isSuiteDetailsLoading ||
      handlers.isGeneratingTests
    ) {
      return;
    }

    if (generatedExploreSuiteRef.current.has(exploreSuite._id)) {
      return;
    }

    if (exploreCases.length > 0) {
      return;
    }

    generatedExploreSuiteRef.current.add(exploreSuite._id);
    void (async () => {
      try {
        await handlers.handleGenerateTests(exploreSuite._id, [selectedServer]);
        await handlers.handleRerun(exploreSuite);
      } catch (error) {
        generatedExploreSuiteRef.current.delete(exploreSuite._id);
        console.error("Failed to prepare explore cases:", error);
      }
    })();
  }, [
    exploreCases.length,
    exploreSuite,
    handlers,
    isServerConnected,
    queries.isSuiteDetailsLoading,
    selectedServer,
    surface,
  ]);

  const handleSurfaceChange = useCallback(
    (nextSurface: TestingSurface) => {
      if (nextSurface === "runs") {
        if (ciEvalsEnabled !== true) {
          toast.info("Runs are only available when the CI feature is enabled.");
          return;
        }
        navigateToCiEvalsRoute({ type: "list" });
        return;
      }

      window.location.hash = withTestingSurface(
        buildEvalsHash({ type: "list" }),
        nextSurface,
      );
    },
    [ciEvalsEnabled],
  );

  const navigateToSavedSuite = useCallback((suiteId: string) => {
    window.location.hash = withTestingSurface(
      buildEvalsHash({ type: "suite-overview", suiteId }),
      "suites",
    );
  }, []);

  const suitesNavigation = useMemo(() => buildSuitesNavigation(), []);

  const exploreNavigation = useMemo((): SuiteNavigation => {
    const toExploreList = () => {
      window.location.hash = withTestingSurface(
        buildEvalsHash({ type: "list" }),
        "explore",
      );
    };
    return {
      toSuiteOverview: (_suiteId, _view) => {
        toExploreList();
      },
      toRunDetail: (suiteId, runId, iteration) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "run-detail", suiteId, runId, iteration }),
          "explore",
        );
      },
      toTestDetail: (suiteId, testId, iteration) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "test-detail", suiteId, testId, iteration }),
          "explore",
        );
      },
      toTestEdit: (suiteId, testId) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "test-edit", suiteId, testId }),
          "explore",
        );
      },
      toSuiteEdit: (suiteId) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "suite-edit", suiteId }),
          "explore",
        );
      },
    };
  }, []);

  const firstFindingCaseId = useMemo(() => {
    if (!suiteAggregate || exploreCases.length === 0) return null;
    const sorted = sortExploreCasesBySignal(
      exploreCases,
      suiteAggregate,
      sortedIterations,
    );
    for (const c of sorted) {
      const row = suiteAggregate.byCase.find((b) => b.testCaseId === c._id);
      if (row && row.failed > 0) return c._id;
    }
    return null;
  }, [exploreCases, suiteAggregate, sortedIterations]);

  const findingCount =
    suiteAggregate?.byCase.filter((item) => item.failed > 0).length ?? 0;
  const totalRunCount = suiteAggregate?.filteredIterations.length ?? 0;
  const hasReviewedCase =
    surface === "explore" &&
    (route.type === "test-detail" ||
      route.type === "test-edit" ||
      route.type === "run-detail");

  const shouldReviewFindings = findingCount > 0 && !hasReviewedCase;
  const allCasesPassed =
    exploreCases.length > 0 && totalRunCount > 0 && findingCount === 0;
  const matchingSavedSuite = useMemo(() => {
    const normalizedName = suiteNameDraft.trim().toLowerCase();
    if (!normalizedName) return null;
    return (
      savedSuiteEntries.find(
        (entry) => entry.suite.name.trim().toLowerCase() === normalizedName,
      ) ?? null
    );
  }, [savedSuiteEntries, suiteNameDraft]);

  const openSaveDialog = useCallback(() => {
    setSuiteNameDraft(
      selectedServer ? `${selectedServer} baseline` : "New suite",
    );
    setSaveModalSelectedIds(exploreCases.map((c) => c._id));
    setIsSaveDialogOpen(true);
  }, [exploreCases, selectedServer]);

  const handleSaveExploreCases = useCallback(async () => {
    if (!workspaceId || !selectedServer) {
      toast.error("Select a workspace and connected server first.");
      return;
    }

    const suiteName = suiteNameDraft.trim();
    if (!suiteName) {
      toast.error("Give this suite a name first.");
      return;
    }

    const selectedCases = exploreCases.filter((testCase) =>
      saveModalSelectedIds.includes(testCase._id),
    );
    if (selectedCases.length === 0) {
      toast.error("Select at least one case to save.");
      return;
    }

    setIsSavingSuite(true);

    try {
      let targetSuiteId = matchingSavedSuite?.suite._id ?? null;
      if (!targetSuiteId) {
        const createdSuite = await mutations.createTestSuiteMutation({
          workspaceId,
          name: suiteName,
          description: `Saved from ${selectedServer} exploration`,
          environment: { servers: [selectedServer] },
        });
        targetSuiteId = createdSuite?._id ?? null;
      }

      if (!targetSuiteId) {
        throw new Error("Failed to create suite");
      }

      const existingCases = (await convex.query(
        "testSuites:listTestCases" as any,
        { suiteId: targetSuiteId },
      )) as EvalCase[];

      for (const testCase of selectedCases) {
        const existingCase = existingCases.find(
          (candidate) =>
            candidate.title === testCase.title && candidate.query === testCase.query,
        );

        if (existingCase) {
          await updateTestCaseMutation({
            testCaseId: existingCase._id,
            title: testCase.title,
            query: testCase.query,
            runs: testCase.runs,
            models: testCase.models,
            expectedToolCalls: testCase.expectedToolCalls,
            isNegativeTest: testCase.isNegativeTest,
            scenario: testCase.scenario,
            expectedOutput: testCase.expectedOutput,
            advancedConfig: testCase.advancedConfig,
          });
        } else {
          await mutations.createTestCaseMutation({
            suiteId: targetSuiteId,
            title: testCase.title,
            query: testCase.query,
            models: testCase.models,
            runs: testCase.runs,
            expectedToolCalls: testCase.expectedToolCalls,
            isNegativeTest: testCase.isNegativeTest,
            scenario: testCase.scenario,
            expectedOutput: testCase.expectedOutput,
            advancedConfig: testCase.advancedConfig,
          });
        }
      }

      toast.success(
        matchingSavedSuite
          ? `Updated "${suiteName}" with ${selectedCases.length} case${selectedCases.length === 1 ? "" : "s"}`
          : `Saved ${selectedCases.length} case${selectedCases.length === 1 ? "" : "s"} to "${suiteName}"`,
      );
      setIsSaveDialogOpen(false);
      window.location.hash = withTestingSurface(
        buildEvalsHash({ type: "suite-overview", suiteId: targetSuiteId }),
        "suites",
      );
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to save suite"));
    } finally {
      setIsSavingSuite(false);
    }
  }, [
    convex,
    exploreCases,
    matchingSavedSuite,
    mutations.createTestCaseMutation,
    mutations.createTestSuiteMutation,
    saveModalSelectedIds,
    selectedServer,
    suiteNameDraft,
    updateTestCaseMutation,
    workspaceId,
  ]);

  const handleGenerateMore = useCallback(async () => {
    if (!exploreSuite || !selectedServer) return;
    await handlers.handleGenerateTests(exploreSuite._id, [selectedServer]);
    await handlers.handleRerun(exploreSuite);
  }, [exploreSuite, handlers, selectedServer]);

  const handleReviewFindings = useCallback(() => {
    if (!exploreSuite || !firstFindingCaseId) return;
    navigateToEvalsRoute({
      type: "test-detail",
      suiteId: exploreSuite._id,
      testId: firstFindingCaseId,
    });
  }, [exploreSuite, firstFindingCaseId]);

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
          description="Create an account or sign in to explore cases, save suites, and investigate runs."
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

  if (surface === "suites" && route.type === "create") {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <TestingShellHeader
          surfaceTitle="Suites"
          subtitle="Saved collections you can rerun and promote into CI when ready."
          surface={surface}
          onSurfaceChange={handleSurfaceChange}
        />
        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-6">
          <EvalRunner
            availableModels={availableModels}
            workspaceId={workspaceId}
            inline={true}
            onSuccess={(suiteId) => {
              window.location.hash = withTestingSurface(
                buildEvalsHash(
                  suiteId
                    ? { type: "suite-overview", suiteId }
                    : { type: "list" },
                ),
                "suites",
              );
            }}
            preselectedServer={selectedServer}
          />
        </div>
      </div>
    );
  }

  const showExploreLoading =
    surface === "explore" &&
    (isPreparingExplore ||
      (selectedServer && isServerConnected && !exploreSuite && queries.isOverviewLoading));

  /** Full-width detail only; list + suite overview use split pane with TestCaseListSidebar. */
  const exploreDetailOnly =
    surface === "explore" &&
    (route.type === "test-detail" ||
      route.type === "test-edit" ||
      route.type === "run-detail" ||
      route.type === "suite-edit");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {surface === "explore" ? (
        <TestingShellHeader
          surfaceTitle="Explore"
          surface={surface}
          onSurfaceChange={handleSurfaceChange}
        />
      ) : (
        <TestingShellHeader
          surfaceTitle="Suites"
          subtitle="Keep the cases you trust and rerun them on demand."
          surface={surface}
          onSurfaceChange={handleSurfaceChange}
        />
      )}

      {surface === "explore" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {exploreDetailOnly ? (
            !isServerConnected ? (
              <div className="flex flex-1 items-center justify-center px-6 py-10">
                <EmptyState
                  icon={FlaskConical}
                  title="Connect a server to start exploring"
                  description="Testing starts from a connected server."
                  className="h-auto"
                />
              </div>
            ) : showExploreLoading ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="mt-4 text-sm text-muted-foreground">
                  Preparing the Explore workspace for {selectedServer}...
                </p>
              </div>
            ) : !exploreSuite ? (
              <div className="flex flex-1 items-center justify-center px-6 py-10">
                <EmptyState
                  icon={FlaskConical}
                  title="Explore is waiting on a connected server"
                  description="Reconnect the server or pick another one from the header."
                  className="h-auto"
                />
              </div>
            ) : queries.isSuiteDetailsLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                  <p className="mt-4 text-sm text-muted-foreground">
                    Loading cases...
                  </p>
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 sm:px-6">
                <SuiteIterationsView
                  suite={exploreSuite}
                  cases={exploreCases}
                  iterations={activeIterations}
                  allIterations={sortedIterations}
                  runs={runsForSelectedSuite}
                  runsLoading={queries.isSuiteRunsLoading}
                  aggregate={suiteAggregate}
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
                />
              </div>
            )
          ) : (
            <>
              <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-3 sm:px-6">
                {handlers.isGeneratingTests && exploreSuite ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200/60 bg-amber-50/80 px-4 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-700 dark:text-amber-400" />
                    <div>
                      <p className="font-medium text-foreground">
                        Generating cases for {selectedServer ?? "this server"}…
                      </p>
                      <p className="text-xs text-muted-foreground">
                        This runs on the server and may take a minute.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div
                    className={
                      findingCount > 0
                        ? "rounded-xl border border-amber-200/70 bg-amber-50/60 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/25"
                        : allCasesPassed
                          ? "rounded-xl border border-emerald-200/70 bg-emerald-50/50 px-4 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/20"
                          : "rounded-xl border border-border/70 bg-card/80 px-4 py-3"
                    }
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-foreground">
                          {findingCount > 0
                            ? `${findingCount} finding${findingCount === 1 ? "" : "s"} worth attention`
                            : allCasesPassed
                              ? `All ${exploreCases.length} cases passed`
                              : exploreCases.length > 0
                                ? `${exploreCases.length} case${exploreCases.length === 1 ? "" : "s"} ready`
                                : selectedServer && isServerConnected
                                  ? "Connect and generate cases to explore"
                                  : "Connect a server to start discovering cases"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {findingCount > 0
                            ? "Review failures first, then save what you want to keep proving."
                            : allCasesPassed
                              ? "Model drift and schema changes can still break you—save a suite to catch regressions early."
                              : selectedServer && isServerConnected
                                ? "Judge signal here before saving anything as a suite."
                                : "Pick a connected server to generate runnable cases."}
                        </p>
                        {selectedServer && isServerConnected && exploreSuite ? (
                          <div className="flex flex-wrap gap-2 pt-1 text-xs text-muted-foreground">
                            <Badge variant="secondary">
                              {exploreCases.length} case
                              {exploreCases.length === 1 ? "" : "s"}
                            </Badge>
                            {totalRunCount > 0 ? (
                              <Badge variant="outline">
                                {totalRunCount} recent run
                                {totalRunCount === 1 ? "" : "s"}
                              </Badge>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                        {shouldReviewFindings ? (
                          <>
                            <Button
                              size="sm"
                              onClick={handleReviewFindings}
                              disabled={!exploreSuite || !firstFindingCaseId}
                              className="min-w-[160px]"
                            >
                              Review findings
                              <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={openSaveDialog}
                              disabled={!exploreSuite || exploreCases.length === 0}
                            >
                              Save as Suite
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            onClick={openSaveDialog}
                            disabled={
                              !exploreSuite ||
                              exploreCases.length === 0 ||
                              handlers.isGeneratingTests
                            }
                            className="min-w-[160px]"
                          >
                            {allCasesPassed
                              ? "Save as Suite — catch drift"
                              : "Save as Suite"}
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1"
                              disabled={!exploreSuite}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                              More
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => void handleGenerateMore()}
                              disabled={handlers.isGeneratingTests}
                            >
                              <Sparkles className="mr-2 h-4 w-4" />
                              Generate more
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                if (exploreSuite) {
                                  void handlers.handleRerun(exploreSuite);
                                }
                              }}
                              disabled={
                                !exploreSuite ||
                                handlers.rerunningSuiteId === exploreSuite?._id
                              }
                            >
                              <RefreshCw
                                className={`mr-2 h-4 w-4 ${handlers.rerunningSuiteId === exploreSuite?._id ? "animate-spin" : ""}`}
                              />
                              Re-run
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                if (exploreSuite) {
                                  void handlers.handleCreateTestCase(exploreSuite._id);
                                }
                              }}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add case
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {!isServerConnected ? (
                  <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
                    <EmptyState
                      icon={FlaskConical}
                      title="Connect a server to start exploring"
                      description="Testing starts from a connected server. Once you connect one, MCPJam will generate cases and show you what it learns."
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
                          handlers.handleDuplicateTestCase(
                            testCaseId,
                            exploreSuite._id,
                          )
                        }
                        onGenerateTests={() => void handleGenerateMore()}
                        deletingTestCaseId={handlers.deletingTestCaseId}
                        duplicatingTestCaseId={handlers.duplicatingTestCaseId}
                        isGeneratingTests={handlers.isGeneratingTests}
                        showingOverview={!selectedTestId}
                        noServerSelected={!isServerConnected}
                        selectedServer={selectedServer}
                        suite={exploreSuite}
                        onRerun={handlers.handleRerun}
                        rerunningSuiteId={handlers.rerunningSuiteId}
                        connectedServerNames={connectedServerNames}
                        showSelection={false}
                        onNavigateToOverview={(suiteId) => {
                          window.location.hash = withTestingSurface(
                            buildEvalsHash({ type: "suite-overview", suiteId }),
                            "explore",
                          );
                        }}
                        onSelectTestCase={(suiteId, testId) => {
                          window.location.hash = withTestingSurface(
                            buildEvalsHash({
                              type: "test-detail",
                              suiteId,
                              testId,
                            }),
                            "explore",
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
                        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 sm:px-6">
                          <SuiteIterationsView
                            suite={exploreSuite}
                            cases={exploreCases}
                            iterations={activeIterations}
                            allIterations={sortedIterations}
                            runs={runsForSelectedSuite}
                            runsLoading={queries.isSuiteRunsLoading}
                            aggregate={suiteAggregate}
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
                          />
                        </div>
                      )}
                    </ResizablePanel>
                  </ResizablePanelGroup>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-4 sm:px-6">
          {route.type === "list" || !savedSuiteEntry || !selectedSuite ? (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {savedSuiteEntries.length}
                  </span>{" "}
                  saved suite{savedSuiteEntries.length === 1 ? "" : "s"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.location.hash = withTestingSurface(
                      buildEvalsHash({ type: "create" }),
                      "suites",
                    );
                  }}
                >
                  Manual suite
                </Button>
              </div>

              {savedSuiteEntries.length === 0 ? (
                <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
                  <LayersPlaceholder />
                  <h3 className="mt-3 text-base font-semibold">No saved suites yet</h3>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    Start in Explore, then save cases you want to keep proving.
                  </p>
                  <Button className="mt-5" onClick={() => handleSurfaceChange("explore")}>
                    Go to Explore
                  </Button>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border bg-card">
                  <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto_auto] gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground sm:px-4">
                    <div>Name</div>
                    <div className="hidden sm:block">Server</div>
                    <div className="text-center sm:text-left">Status</div>
                    <div className="hidden text-right md:block">Last run</div>
                    <div className="text-right"> </div>
                  </div>
                  <div className="divide-y">
                    {savedSuiteEntries.map((entry) => {
                      const suite = entry.suite;
                      const latestRun = entry.latestRun;
                      const latestTimestamp =
                        latestRun?.completedAt ??
                        latestRun?.createdAt ??
                        suite.updatedAt ??
                        suite._creationTime;
                      const missingServers = (suite.environment?.servers || []).filter(
                        (server) => !connectedServerNames.has(server),
                      );
                      const canRun = missingServers.length === 0;
                      const isRunning = handlers.rerunningSuiteId === suite._id;

                      return (
                        <div
                          key={suite._id}
                          className="grid grid-cols-1 items-start gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto_auto] sm:items-center sm:gap-2 sm:px-4"
                        >
                          <button
                            type="button"
                            onClick={() => navigateToSavedSuite(suite._id)}
                            className="min-w-0 text-left"
                          >
                            <div className="truncate font-medium text-foreground hover:underline">
                              {suite.name}
                            </div>
                            {missingServers.length > 0 ? (
                              <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                                Connect {missingServers.join(", ")} to run.
                              </p>
                            ) : null}
                          </button>
                          <div className="hidden text-sm text-muted-foreground sm:block">
                            {(suite.environment?.servers || []).join(", ") || "—"}
                          </div>
                          <div className="flex justify-center sm:justify-start">
                            {latestRun?.result === "failed" ? (
                              <Badge variant="destructive" className="text-xs">
                                {latestRun.summary?.failed ?? 0} finding
                                {(latestRun.summary?.failed ?? 0) === 1 ? "" : "s"}
                              </Badge>
                            ) : latestRun?.result === "passed" ? (
                              <Badge variant="secondary" className="text-xs">
                                Passing
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                          <div className="hidden text-right text-xs text-muted-foreground md:block">
                            {formatRelativeTime(latestTimestamp)}
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handlers.handleRerun(suite);
                              }}
                              disabled={!canRun || isRunning}
                            >
                              <RefreshCw
                                className={`mr-2 h-4 w-4 ${isRunning ? "animate-spin" : ""}`}
                              />
                              Run now
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigateToSavedSuite(suite._id);
                              }}
                            >
                              View cases
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : queries.isSuiteDetailsLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <p className="mt-4 text-sm text-muted-foreground">
                  Loading suite data...
                </p>
              </div>
            </div>
          ) : (
            <SuiteIterationsView
              suite={selectedSuite}
              cases={suiteDetails?.testCases || []}
              iterations={activeIterations}
              allIterations={sortedIterations}
              runs={runsForSelectedSuite}
              runsLoading={queries.isSuiteRunsLoading}
              aggregate={suiteAggregate}
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
              navigation={suitesNavigation}
              onSetupCi={
                ciEvalsEnabled === true
                  ? () => setSuiteForCiSetup(selectedSuite)
                  : undefined
              }
            />
          )}
        </div>
      )}

      <Dialog open={isSaveDialogOpen} onOpenChange={setIsSaveDialogOpen}>
        <DialogContent className="max-h-[min(90vh,720px)] gap-0 overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Save selected cases as a suite</DialogTitle>
            <DialogDescription>
              Keep the cases you discovered in Explore and rerun them over time.
              Existing suites with the same name will be updated instead of duplicated.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto py-2">
            <div className="space-y-2">
              <Label htmlFor="suite-name">Suite name</Label>
              <Input
                id="suite-name"
                value={suiteNameDraft}
                onChange={(event) => setSuiteNameDraft(event.target.value)}
                placeholder="weather-api baseline"
              />
            </div>

            <div className="space-y-2">
              <Label>Cases to include</Label>
              <div className="max-h-[min(40vh,280px)] space-y-2 overflow-y-auto rounded-xl border bg-muted/20 p-2">
                {exploreCases.map((c) => (
                  <label
                    key={c._id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={saveModalSelectedIds.includes(c._id)}
                      onCheckedChange={(checked) => {
                        const on = checked === true;
                        setSaveModalSelectedIds((prev) =>
                          on
                            ? prev.includes(c._id)
                              ? prev
                              : [...prev, c._id]
                            : prev.filter((id) => id !== c._id),
                        );
                      }}
                      className="mt-0.5"
                    />
                    <span className="text-sm leading-snug">{c.title}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/30 p-3 text-sm text-muted-foreground">
              Saving{" "}
              <span className="font-medium text-foreground">
                {saveModalSelectedIds.length}
              </span>{" "}
              case{saveModalSelectedIds.length === 1 ? "" : "s"} from{" "}
              <span className="font-medium text-foreground">
                {selectedServer || "the current server"}
              </span>
              .
              {matchingSavedSuite ? (
                <p className="mt-2 text-xs">
                  We&apos;ll update the existing suite named &quot;{matchingSavedSuite.suite.name}&quot;
                  and add anything new.
                </p>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingSuite}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleSaveExploreCases()} disabled={isSavingSuite}>
              {isSavingSuite ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save as Suite"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={suiteForCiSetup !== null} onOpenChange={(open) => !open && setSuiteForCiSetup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Setup CI</DialogTitle>
            <DialogDescription>
              Move this suite from manual confidence to ongoing proof. Open Runs to
              track CI-backed executions and compare them against manual runs in one place.
            </DialogDescription>
          </DialogHeader>

          {suiteForCiSetup ? (
            <div className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{suiteForCiSetup.name}</p>
              <p className="mt-2">
                Use Runs to inspect commit history, replay failures, and see how this
                suite behaves once it starts running in CI.
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setSuiteForCiSetup(null)}>
              Close
            </Button>
            <Button
              onClick={() => {
                if (suiteForCiSetup) {
                  navigateToCiEvalsRoute({
                    type: "suite-overview",
                    suiteId: suiteForCiSetup._id,
                  });
                }
              }}
            >
              Open Runs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

function LayersPlaceholder() {
  return (
    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-muted">
      <Sparkles className="h-10 w-10 text-muted-foreground" />
    </div>
  );
}
