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
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
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
  useEvalsRoute,
  type EvalsRoute,
} from "@/lib/evals-router";
import { navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import { withTestingSurface, type TestingSurface } from "@/lib/testing-surface";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";
import { aggregateSuite, sortExploreCasesBySignal } from "./evals/helpers";
import { SuiteIterationsView, type SuiteNavigation } from "./evals/suite-iterations-view";
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

export function EvalsTab({ selectedServer, workspaceId }: EvalsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const route = useEvalsRoute();
  const convex = useConvex();
  const appState = useSharedAppState();
  const { availableModels } = useAvailableEvalModels();
  const updateSuiteMutation = useMutation("testSuites:updateTestSuite" as any);
  const updateTestCaseMutation = useMutation("testSuites:updateTestCase" as any);
  const mutations = useEvalMutations();

  const [isPreparingExplore, setIsPreparingExplore] = useState(false);
  const [saveModalSelectedIds, setSaveModalSelectedIds] = useState<string[]>(
    [],
  );
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [suiteNameDraft, setSuiteNameDraft] = useState("");
  const [isSavingSuite, setIsSavingSuite] = useState(false);
  const initializedExploreRef = useRef<Set<string>>(new Set());
  const generatedExploreSuiteRef = useRef<Set<string>>(new Set());

  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
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

  const selectedSuiteId = exploreSuiteEntry?.suite._id ?? null;

  const activeSuiteEntry = exploreSuiteEntry;

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

  const exploreSuite = selectedSuite;
  const exploreCases = suiteDetails?.testCases ?? EMPTY_CASES;

  useEffect(() => {
    if (!selectedServer || !isServerConnected || !workspaceId || !isAuthenticated) {
      return;
    }
    if (exploreSuiteEntry) {
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
    updateSuiteMutation,
    workspaceId,
  ]);

  useEffect(() => {
    if (
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
  ]);

  const handleSurfaceChange = useCallback((nextSurface: TestingSurface) => {
    if (nextSurface === "runs") {
      navigateToCiEvalsRoute({ type: "list" });
      return;
    }

    window.location.hash = withTestingSurface(buildEvalsHash({ type: "list" }));
  }, []);

  const exploreNavigation = useMemo((): SuiteNavigation => {
    const toExploreList = () => {
      window.location.hash = withTestingSurface(buildEvalsHash({ type: "list" }));
    };
    return {
      toSuiteOverview: (_suiteId, _view) => {
        toExploreList();
      },
      toRunDetail: (suiteId, runId, iteration) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "run-detail", suiteId, runId, iteration }),
        );
      },
      toTestDetail: (suiteId, testId, iteration) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "test-detail", suiteId, testId, iteration }),
        );
      },
      toTestEdit: (suiteId, testId) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "test-edit", suiteId, testId }),
        );
      },
      toSuiteEdit: (suiteId) => {
        window.location.hash = withTestingSurface(
          buildEvalsHash({ type: "suite-edit", suiteId }),
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
    route.type === "test-detail" ||
    route.type === "test-edit" ||
    route.type === "run-detail";

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
      navigateToCiEvalsRoute({
        type: "suite-overview",
        suiteId: targetSuiteId,
      });
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
    window.location.hash = withTestingSurface(
      buildEvalsHash({
        type: "test-edit",
        suiteId: exploreSuite._id,
        testId: firstFindingCaseId,
      }),
    );
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

  const showExploreLoading =
    isPreparingExplore ||
    (selectedServer &&
      isServerConnected &&
      !exploreSuite &&
      queries.isOverviewLoading);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <TestingShellHeader
        surface="explore"
        onSurfaceChange={handleSurfaceChange}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <>
              <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2 sm:px-6">
                {handlers.isGeneratingTests && exploreSuite ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Generating cases for{" "}
                      <span className="font-medium text-foreground">
                        {selectedServer ?? "this server"}
                      </span>
                      …
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 text-sm text-muted-foreground">
                      {findingCount > 0 ? (
                        <>
                          <span className="font-medium text-foreground">
                            {findingCount}
                          </span>{" "}
                          finding{findingCount === 1 ? "" : "s"} across{" "}
                          <span className="font-medium text-foreground">
                            {exploreCases.length}
                          </span>{" "}
                          case{exploreCases.length === 1 ? "" : "s"}
                        </>
                      ) : allCasesPassed ? (
                        <>
                          All{" "}
                          <span className="font-medium text-foreground">
                            {exploreCases.length}
                          </span>{" "}
                          passed
                        </>
                      ) : exploreCases.length > 0 ? (
                        <>
                          <span className="font-medium text-foreground">
                            {exploreCases.length}
                          </span>{" "}
                          case{exploreCases.length === 1 ? "" : "s"} ready
                        </>
                      ) : selectedServer && isServerConnected ? (
                        "Connect and generate cases to explore"
                      ) : (
                        "Connect a server to start discovering cases"
                      )}
                    </p>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {shouldReviewFindings ? (
                        <>
                          <Button
                            size="sm"
                            onClick={handleReviewFindings}
                            disabled={!exploreSuite || !firstFindingCaseId}
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
                        >
                          Save as Suite
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            disabled={!exploreSuite}
                            aria-label="More actions"
                          >
                            <MoreHorizontal className="h-4 w-4" />
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
        </div>

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
