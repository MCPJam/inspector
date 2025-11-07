import { useState, useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { FlaskConical, Plus, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { EvalCase, EvalIteration, EvalSuite } from "./evals/types";
import { aggregateSuite } from "./evals/helpers";
import { SuitesOverview } from "./evals/suites-overview";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { EvalRunner } from "./evals/eval-runner";
import { useChat } from "@/hooks/use-chat";

type View = "results" | "run";

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  const [view, setView] = useState<View>("results");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);

  const { availableModels } = useChat({
    systemPrompt: "",
    temperature: 1,
    selectedServers: [],
  });

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

  // Handle back navigation
  const handleBack = () => {
    if (selectedSuiteId) {
      setSelectedSuiteId(null);
    } else if (view === "run") {
      setView("results");
    }
  };

  // Show back button if we're in run view OR viewing suite details
  const showBackButton = view === "run" || !!selectedSuiteId;

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
              onClick={() => setView("run")}
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
          <EvalRunner availableModels={availableModels} inline={true} />
        ) : !selectedSuite ? (
          <SuitesOverview
            suites={suites || []}
            onSelectSuite={setSelectedSuiteId}
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
          />
        )}
      </div>
    </div>
  );
}
