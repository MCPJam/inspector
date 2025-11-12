import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { FlaskConical, Plus, ArrowLeft, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "./evals/types";
import { aggregateSuite } from "./evals/helpers";
import { SuitesOverview } from "./evals/suites-overview";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { EvalRunner } from "./evals/eval-runner";
import { useChat } from "@/hooks/use-chat";
import { useAppState } from "@/hooks/use-app-state";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel } from "@/shared/types";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import posthog from "posthog-js";

type View = "results" | "run";

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user, getAccessToken } = useAuth();

  const [view, setView] = useState<View>("results");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  const [rerunningSuiteId, setRerunningSuiteId] = useState<string | null>(null);

  const [deletingSuiteId, setDeletingSuiteId] = useState<string | null>(null);
  const [suiteToDelete, setSuiteToDelete] = useState<EvalSuite | null>(null);

  const { availableModels } = useChat({
    systemPrompt: "",
    temperature: 1,
    selectedServers: [],
  });

  const { appState } = useAppState();
  const { getToken, hasToken } = useAiProviderKeys();

  const deleteSuiteMutation = useMutation("evals:deleteSuite" as any);

  useEffect(() => {
    posthog.capture("evals_tab_viewed", {
      location: "evals_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);


  // Get connected server names
  const connectedServerNames = useMemo(
    () =>
      new Set(
        Object.entries(appState.servers)
          .filter(([, server]) => server.connectionStatus === "connected")
          .map(([name]) => name),
      ),
    [appState.servers],
  );

  const enableOverviewQuery = isAuthenticated && !!user;
  const suiteOverview = useQuery(
    "evals:getSuiteOverview" as any,
    enableOverviewQuery ? ({} as any) : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  const enableSuiteDetailsQuery =
    isAuthenticated && !!user && !!selectedSuiteId;
  const suiteDetails = useQuery(
    "evals:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip",
  ) as unknown as
    | { testCases: EvalCase[]; iterations: EvalIteration[] }
    | undefined;

  const suiteRuns = useQuery(
    "evals:getSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 20 } as any)
      : "skip",
  ) as EvalSuiteRun[] | undefined;

  const isOverviewLoading = suiteOverview === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;

  const isSuiteRunsLoading =
    enableSuiteDetailsQuery && suiteRuns === undefined;

  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId || !suiteOverview) return null;
    return (
      suiteOverview.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [selectedSuiteId, suiteOverview]);

  const selectedSuite = selectedSuiteEntry?.suite ?? null;

  const sortedIterations = useMemo(() => {
    if (!suiteDetails) return [];
    return [...suiteDetails.iterations].sort(
      (a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt),
    );
  }, [suiteDetails]);

  const runsForSelectedSuite = useMemo(
    () => (suiteRuns ? [...suiteRuns] : []),
    [suiteRuns],
  );

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      sortedIterations,
    );
  }, [selectedSuite, suiteDetails, sortedIterations]);

  // Rerun handler
  const handleRerun = useCallback(
    async (suite: EvalSuite) => {
      if (rerunningSuiteId) return;

      const suiteServers = suite.config?.environment?.servers || [];
      const missingServers = suiteServers.filter(
        (server) => !connectedServerNames.has(server),
      );

      if (missingServers.length > 0) {
        toast.error(
          `Please connect the following servers first: ${missingServers.join(", ")}`,
        );
        return;
      }

      // Get the tests from the suite config
      const tests = suite.config?.tests || [];
      if (tests.length === 0) {
        toast.error("No tests found in this suite");
        return;
      }

      // Check if we have the model and API keys
      const firstTest = tests[0];
      const modelId = firstTest.model;
      const provider = firstTest.provider;

      const currentModelIsJam = isMCPJamProvidedModel(modelId);
      let apiKey: string | undefined;

      if (!currentModelIsJam) {
        const tokenKey = provider.toLowerCase() as keyof ProviderTokens;
        if (!hasToken(tokenKey)) {
          toast.error(
            `Please add your ${provider} API key in Settings before running evals`,
          );
          return;
        }
        apiKey = getToken(tokenKey) || undefined;
      }

      setRerunningSuiteId(suite._id);

      try {
        const accessToken = await getAccessToken();

        const response = await fetch("/api/mcp/evals/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            suiteId: suite._id,
            suiteName: suite.name,
            suiteDescription: suite.description,
            tests: tests.map((test) => ({
              title: test.title,
              query: test.query,
              runs: test.runs ?? 1,
              model: test.model,
              provider: test.provider,
              expectedToolCalls: test.expectedToolCalls,
              judgeRequirement: test.judgeRequirement,
              advancedConfig: test.advancedConfig,
            })),
            serverIds: suiteServers,
            modelApiKey: currentModelIsJam ? null : apiKey || null,
            convexAuthToken: accessToken,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "Failed to start eval run");
        }

        toast.success(
          "Eval run started successfully! Results will appear shortly.",
        );
      } catch (error) {
        console.error("Failed to rerun evals:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to start eval run",
        );
      } finally {
        setRerunningSuiteId(null);
      }
    },
    [
      rerunningSuiteId,
      connectedServerNames,
      getAccessToken,
      hasToken,
      getToken,
    ],
  );

  // Delete handler - opens confirmation modal
  const handleDelete = useCallback(
    (suite: EvalSuite) => {
      if (deletingSuiteId) return;
      setSuiteToDelete(suite);
    },
    [deletingSuiteId],
  );

  // Confirm deletion - actually performs the deletion
  const confirmDelete = useCallback(async () => {
    if (!suiteToDelete || deletingSuiteId) return;

    setDeletingSuiteId(suiteToDelete._id);

    try {
      await deleteSuiteMutation({ suiteId: suiteToDelete._id });
      toast.success("Test suite deleted successfully");

      // If we're viewing this suite, go back to the overview
      if (selectedSuiteId === suiteToDelete._id) {
        setSelectedSuiteId(null);
      }

      setSuiteToDelete(null);
    } catch (error) {
      console.error("Failed to delete suite:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete test suite",
      );
    } finally {
      setDeletingSuiteId(null);
    }
  }, [suiteToDelete, deletingSuiteId, deleteSuiteMutation, selectedSuiteId]);

  // Handle back navigation
  const handleBack = () => {
    if (view === "run") {
      setView("results");
    }
  };

  // Handle eval run success - navigate back to results view
  const handleEvalRunSuccess = useCallback(() => {
    setView("results");
    setSelectedSuiteId(null);
  }, []);

  // Show back button only in run view (suite details has its own back button)
  const showBackButton = view === "run";

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
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
          icon={FlaskConical}
          title="Sign in to use evals"
          description="Create an account or sign in to run evaluations and view results."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  if (isOverviewLoading && enableOverviewQuery && view === "results") {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">
              Loading your eval data...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 p-6 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {showBackButton && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBack}
                className="h-8 w-8 p-0"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <h1 className="text-2xl font-semibold">
              {view === "run"
                ? "Create evaluation run"
                : selectedSuiteId
                  ? selectedSuite?.name || "Test suite results"
                  : "Test suites"}
            </h1>
          </div>
          {view === "results" && !selectedSuiteId && (
            <Button
              onClick={() => {
                posthog.capture("create_new_run_button_clicked", {
                  location: "evals_tab",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                setView("run");
              }}
              className="gap-2"
              size="sm"
            >
              <Plus className="h-4 w-4" />
              Create new test suite
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {view === "run" ? (
          <EvalRunner
            availableModels={availableModels}
            inline={true}
            onSuccess={handleEvalRunSuccess}
          />
        ) : !selectedSuite ? (
          <SuitesOverview
            overview={suiteOverview || []}
            onSelectSuite={setSelectedSuiteId}
            onRerun={handleRerun}
            onDelete={handleDelete}
            connectedServerNames={connectedServerNames}
            rerunningSuiteId={rerunningSuiteId}
            deletingSuiteId={deletingSuiteId}
          />
        ) : isSuiteDetailsLoading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              <p className="mt-4 text-muted-foreground">
                Loading suite details...
              </p>
            </div>
          </div>
        ) : (
          <SuiteIterationsView
            suite={selectedSuite}
            cases={suiteDetails?.testCases || []}
            iterations={sortedIterations}
            allIterations={sortedIterations}
            runs={runsForSelectedSuite}
            runsLoading={isSuiteRunsLoading}
            aggregate={suiteAggregate}
            onBack={() => setSelectedSuiteId(null)}
            onRerun={handleRerun}
            onDelete={handleDelete}
            connectedServerNames={connectedServerNames}
            rerunningSuiteId={rerunningSuiteId}
            deletingSuiteId={deletingSuiteId}
          />
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Dialog open={!!suiteToDelete} onOpenChange={(open) => !open && setSuiteToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Test Suite
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the test suite{" "}
              <span className="font-semibold">
                "{suiteToDelete?.name || "Untitled suite"}"
              </span>
              ?
              <br />
              <br />
              This will permanently delete all test cases, runs, and iterations
              associated with this suite. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSuiteToDelete(null)}
              disabled={!!deletingSuiteId}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={!!deletingSuiteId}
            >
              {deletingSuiteId ? "Deleting..." : "Delete Suite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
