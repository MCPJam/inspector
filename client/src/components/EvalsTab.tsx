import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { FlaskConical, Plus, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { EvalCase, EvalIteration, EvalSuite } from "./evals/types";
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

  const { availableModels } = useChat({
    systemPrompt: "",
    temperature: 1,
    selectedServers: [],
  });

  const { appState } = useAppState();
  const { getToken, hasToken } = useAiProviderKeys();

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
  const overviewData = useQuery(
    "evals:getCurrentUserEvalTestSuitesWithMetadata" as any,
    enableOverviewQuery ? ({} as any) : "skip",
  ) as unknown as
    | {
        testSuites: EvalSuite[];
        metadata: { iterationsPassed: number; iterationsFailed: number };
      }
    | undefined;

  const enableSuiteDetailsQuery =
    isAuthenticated && !!user && !!selectedSuiteId;
  const suiteDetails = useQuery(
    "evals:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip",
  ) as unknown as
    | { testCases: EvalCase[]; iterations: EvalIteration[] }
    | undefined;

  const suites = overviewData?.testSuites;
  const isOverviewLoading = overviewData === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;

  const selectedSuite = useMemo(() => {
    if (!selectedSuiteId || !suites) return null;
    return suites.find((suite) => suite._id === selectedSuiteId) ?? null;
  }, [selectedSuiteId, suites]);

  const iterationsForSelectedSuite = useMemo(() => {
    if (!suiteDetails) return [];
    return [...suiteDetails.iterations].sort(
      (a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt),
    );
  }, [suiteDetails]);

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      suiteDetails.iterations,
    );
  }, [selectedSuite, suiteDetails]);

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
            tests: tests.map((test) => ({
              title: test.title,
              query: test.query,
              runs: 1, // Default to 1 run for rerun
              model: test.model,
              provider: test.provider,
              expectedToolCalls: test.expectedToolCalls,
            })),
            serverIds: suiteServers,
            llmConfig: {
              provider,
              apiKey: currentModelIsJam ? "router" : apiKey || "router",
            },
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
                  ? "Evaluation results"
                  : "Evaluation results"}
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
              Create new run
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
            suites={suites || []}
            onSelectSuite={setSelectedSuiteId}
            onRerun={handleRerun}
            connectedServerNames={connectedServerNames}
            rerunningSuiteId={rerunningSuiteId}
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
            iterations={iterationsForSelectedSuite}
            aggregate={suiteAggregate}
            onBack={() => setSelectedSuiteId(null)}
            onRerun={handleRerun}
            connectedServerNames={connectedServerNames}
            rerunningSuiteId={rerunningSuiteId}
          />
        )}
      </div>
    </div>
  );
}
